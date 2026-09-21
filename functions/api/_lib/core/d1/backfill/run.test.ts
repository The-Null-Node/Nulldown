import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import {
  encodeDropEnvelope,
  serializeDropEnvelopeForDeviceSignature,
  toDropEnvelopeSignable,
} from "../../../../../../shared/drop/codecs/envelope-v1";
import {
  serializeDropDeviceDelegationForSignature,
  toDropDeviceDelegationSignable,
} from "../../../../../../shared/drop/codecs/device-delegation-v1";
import type { DropEnvelope } from "../../../../../../shared/drop/types";
import type { DropDeviceDelegation } from "../../../../../../shared/drop/deviceDelegation";
import { toShortDropId } from "../../../../../../shared/drop/id";
import { dropResolvedHeapKey } from "../../../../../../shared/drop/sidecar";
import { RESOLVED_DOCUMENT_RESOLVER_ID } from "../../../../../../shared/drop/resolved/constants";
import type { ResolvedNulldownState } from "../../../../../../shared/drop/resolved/types";
import { writeBranch } from "../../../branches/storage/repository";
import {
  MemoryD1Database,
  MemoryR2Bucket,
  createBranch,
} from "../testing/metadata-fixture";
import { backfillD1Metadata } from "./run";

const toBase64Url = (bytes: ArrayBuffer): string => {
  let binary = "";
  new Uint8Array(bytes).forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

const createMismatchedDelegatedEnvelope = async (): Promise<{
  envelope: DropEnvelope;
  accountPublicJwk: JsonWebKey;
  encryptionPublicJwk: JsonWebKey;
}> => {
  const accountPair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const delegatePair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const encryptionPair = (await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKeyPair;
  const accountPublicJwk = await crypto.subtle.exportKey(
    "jwk",
    accountPair.publicKey,
  );
  const delegateSigningPublicJwk = await crypto.subtle.exportKey(
    "jwk",
    delegatePair.publicKey,
  );
  const exportedEncryptionPublicJwk = await crypto.subtle.exportKey(
    "jwk",
    encryptionPair.publicKey,
  );
  const encryptionPublicJwk = {
    kty: exportedEncryptionPublicJwk.kty,
    n: exportedEncryptionPublicJwk.n,
    e: exportedEncryptionPublicJwk.e,
  };
  const delegation: DropDeviceDelegation = {
    accountId: "account_a",
    credentialId: "A".repeat(22),
    delegateSigningPublicJwk,
    encryptionKid: "enc_a",
    encryptionPublicJwk: { kty: "RSA", n: "A".repeat(342), e: "AQAB" },
    issuedAt: Date.now() - 1,
    expiresAt: Date.now() + 60_000,
    signature: {
      kid: "account_a",
      alg: "ECDSA_P256_SHA256",
      sig: "placeholder",
    },
  };
  delegation.signature.sig = toBase64Url(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      accountPair.privateKey,
      new TextEncoder().encode(
        serializeDropDeviceDelegationForSignature(
          toDropDeviceDelegationSignable(delegation),
        ),
      ),
    ),
  );
  const envelope: DropEnvelope = {
    createdAt: Date.now(),
    accountId: "account_a",
    visibility: "private",
    cipher: { alg: "A256GCM", iv: "iv", ciphertext: "ciphertext-secret" },
    keyEnvelope: {
      mode: "account-vault-rsa-oaep",
      kid: "enc_a",
      wrappedKey: "wrapped-secret",
    },
    deviceSignerPublicJwk: delegateSigningPublicJwk,
    deviceDelegation: delegation,
    signatures: {
      device: { kid: "delegate", alg: "ECDSA_P256_SHA256", sig: "placeholder" },
    },
  };
  envelope.signatures.device.sig = toBase64Url(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      delegatePair.privateKey,
      new TextEncoder().encode(
        serializeDropEnvelopeForDeviceSignature(
          toDropEnvelopeSignable(envelope),
        ),
      ),
    ),
  );
  return { envelope, accountPublicJwk, encryptionPublicJwk };
};

describe("D1 metadata backfill contracts", () => {
  it("backfills R2 drop and branch metadata into D1", async () => {
    const bucket = new MemoryR2Bucket();
    const db = new MemoryD1Database();
    const branch = createBranch();
    const rootDropId = branch.rootDropId;

    await bucket.put(
      rootDropId,
      JSON.stringify(
        encodeDropEnvelope({
          createdAt: 1000,
          accountId: "acct_1",
          visibility: "public",
          metadata: { topic: "d1" },
          cipher: { alg: "A256GCM", iv: "iv", ciphertext: "ciphertext" },
          keyEnvelope: {
            mode: "account-vault-rsa-oaep",
            kid: "kid_1",
            wrappedKey: "wrapped",
          },
          signatures: {
            device: { kid: "kid_1", alg: "ECDSA_P256_SHA256", sig: "sig" },
          },
        }),
      ),
      { httpMetadata: { contentType: "application/json" } },
    );
    await writeBranch(bucket as unknown as R2Bucket, branch);
    await bucket.put(
      `__drop_writer_branch__/${rootDropId}/account:acct_1.txt`,
      branch.branchId,
      { httpMetadata: { contentType: "text/plain" } },
    );

    const response = await backfillD1Metadata(
      {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as unknown as D1Database,
        METADATA_BACKFILL_TOKEN: "secret",
      },
      new Request("https://example.test/api/metadata/backfill?limit=20", {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
      }),
    );
    const body = (await response.json()) as { stats: Record<string, number> };

    expect(response.status).toBe(200);
    expect(body.stats.dropsUpserted).toBe(1);
    expect(body.stats.branchesUpserted).toBe(1);
    expect(body.stats.writerPointersUpserted).toBe(1);
    expect(db.aliases.get(toShortDropId(rootDropId))?.full_id).toBe(rootDropId);
    expect(db.drops.get(rootDropId)?.visibility).toBe("public");
    expect(db.publicDrops.has(rootDropId)).toBe(true);
    expect(db.branches.has(`${rootDropId}/${branch.branchId}`)).toBe(true);
    expect(db.writers.get(`${rootDropId}/account:acct_1`)?.branch_id).toBe(
      branch.branchId,
    );
  });

  it("backfills only account-owned rows for the account-library projection", async () => {
    const bucket = new MemoryR2Bucket();
    const db = new MemoryD1Database();
    const rootDropId = createBranch().rootDropId;

    await bucket.put(
      rootDropId,
      JSON.stringify(
        encodeDropEnvelope({
          createdAt: 1000,
          accountId: "acct_1",
          visibility: "unlisted",
          metadata: { topic: "library" },
          cipher: { alg: "A256GCM", iv: "iv", ciphertext: "ciphertext" },
          keyEnvelope: {
            mode: "account-vault-rsa-oaep",
            kid: "kid_1",
            wrappedKey: "wrapped",
          },
          signatures: {
            device: { kid: "kid_1", alg: "ECDSA_P256_SHA256", sig: "sig" },
          },
        }),
      ),
      { httpMetadata: { contentType: "application/json" } },
    );
    db.drops.set(rootDropId, {
      id: rootDropId,
      visibility: "unlisted",
      owner_account_id: "acct_1",
    });

    const response = await backfillD1Metadata(
      {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as unknown as D1Database,
        METADATA_BACKFILL_TOKEN: "secret",
      },
      new Request(
        "https://example.test/api/metadata/backfill?mode=account-library&limit=1",
        {
          method: "POST",
          headers: { Authorization: "Bearer secret" },
        },
      ),
    );
    const body = (await response.json()) as {
      mode: string;
      stats: Record<string, number>;
      cursor: string | null;
      truncated: boolean;
    };

    expect(response.status).toBe(200);
    expect(body.mode).toBe("account-library");
    expect(body.stats.scanned).toBe(1);
    expect(body.stats.skipped).toBe(1);
    expect(body.cursor).toBe(rootDropId);
    expect(body.truncated).toBe(true);
  });

  it("skips a backfill envelope whose delegated recipient differs from the account pin without disclosing sealed data", async () => {
    const bucket = new MemoryR2Bucket();
    const db = new MemoryD1Database();
    const { envelope, accountPublicJwk, encryptionPublicJwk } =
      await createMismatchedDelegatedEnvelope();
    const dropId = "RecipientMismatch123";

    await bucket.put(dropId, JSON.stringify(encodeDropEnvelope(envelope)), {
      httpMetadata: { contentType: "application/json" },
    });
    db.drops.set(dropId, {
      id: dropId,
      visibility: "private",
      owner_account_id: "account_a",
    });
    db.accounts.set("account_a", {
      account_id: "account_a",
      signing_public_jwk: JSON.stringify(accountPublicJwk),
      encryption_kid: "enc_a",
      encryption_public_jwk: JSON.stringify(encryptionPublicJwk),
      created_at: 1,
      updated_at: 1,
    });

    const response = await backfillD1Metadata(
      {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as unknown as D1Database,
        METADATA_BACKFILL_TOKEN: "secret",
      },
      new Request(
        "https://example.test/api/metadata/backfill?mode=account-library",
        {
          method: "POST",
          headers: { Authorization: "Bearer secret" },
        },
      ),
    );
    const body = (await response.json()) as {
      stats: {
        accountLibraryUpserted: number;
        accountLibrarySkipped: Record<string, number>;
      };
    };
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.stats.accountLibraryUpserted).toBe(0);
    expect(body.stats.accountLibrarySkipped.expired_or_untrusted).toBe(1);
    expect(serialized).not.toContain("ciphertext-secret");
    expect(serialized).not.toContain("wrapped-secret");
  });

  it("backfills R2 resolved heap sidecars into compact v2 D1 rows", async () => {
    const bucket = new MemoryR2Bucket();
    const db = new MemoryD1Database();
    const branch = createBranch();
    const state: ResolvedNulldownState = {
      version: 1,
      id: `resolved:${branch.rootDropId}:${branch.branchId}:0:${RESOLVED_DOCUMENT_RESOLVER_ID}`,
      rootDropId: branch.rootDropId,
      branchId: branch.branchId,
      snapshotId: 0,
      sourceContentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      resolverId: RESOLVED_DOCUMENT_RESOLVER_ID,
      resolverVersion: "1",
      resolvedAt: 1_700_000_010_000,
      title: "Backfill Heap",
      documentNodes: [
        {
          id: "heading:backfill:0:14",
          kind: "heading",
          text: "Backfill Heap",
          sourceRange: { start: 0, end: 14 },
          sourceHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          importance: 3.3,
        },
        {
          id: "paragraph:backfill:16:46",
          kind: "paragraph",
          text: "Compact v2 backfill paragraph.",
          sourceRange: { start: 16, end: 46 },
          sourceHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      ],
    };

    await bucket.put(
      dropResolvedHeapKey(
        branch.rootDropId,
        branch.branchId,
        RESOLVED_DOCUMENT_RESOLVER_ID,
        0,
      ),
      JSON.stringify(state),
      { httpMetadata: { contentType: "application/json" } },
    );

    const response = await backfillD1Metadata(
      {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as unknown as D1Database,
        METADATA_BACKFILL_TOKEN: "secret",
      },
      new Request("https://example.test/api/metadata/backfill?limit=20", {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
      }),
    );
    const body = (await response.json()) as { stats: Record<string, number> };

    expect(response.status).toBe(200);
    expect(body.stats.resolvedHeapsUpserted).toBe(1);
    const deltaRow = db.heapDeltas.get(
      `${branch.rootDropId}/${branch.branchId}/0/${RESOLVED_DOCUMENT_RESOLVER_ID}`,
    );
    const delta = JSON.parse(deltaRow?.heap_delta_json ?? "null") as {
      checkpointed: boolean;
      nodeRefs?: unknown[];
    };

    expect(delta.checkpointed).toBe(true);
    expect(delta.nodeRefs).toHaveLength(2);
    expect(db.nodes.size).toBe(2);
    expect(db.nodeRefs.size).toBe(2);
    expect(db.nodePayloads.size).toBe(2);
  });
});

import { createHash } from "node:crypto";
import { jest } from "@jest/globals";
import type { R2Bucket } from "@cloudflare/workers-types";
import { createRemoteAliasKey } from "../functions/api/_lib/drops/identity/id";
import { acquireRootMutationLock } from "../functions/api/_lib/drops/storage/mutationLock";
import { onRequestDelete } from "../functions/api/delete/[id]";
import { onRequestGet } from "../functions/api/get/[id]";
import { onRequestPost as onStorePost } from "../functions/api/store";
import {
  encodeDropEnvelope,
  serializeDropEnvelopeForDeviceSignature,
  toDropEnvelopeSignable,
} from "../shared/drop/codecs/envelope-v1";
import type { DropEnvelope } from "../shared/drop/types";

interface StoredObject {
  value: string;
  contentType: string;
  etag: string;
  uploaded: Date;
}

class MemoryR2Bucket {
  private readonly objects = new Map<string, StoredObject>();

  seed(key: string, value: string, contentType = "application/json"): string {
    const etag = this.createEtag(`${key}:${value}:${Date.now()}`);
    this.objects.set(key, {
      value,
      contentType,
      etag,
      uploaded: new Date(),
    });

    return etag;
  }

  async get(key: string): Promise<any> {
    const existing = this.objects.get(key);
    if (!existing) {
      return null;
    }

    return {
      body: new Response(existing.value).body,
      httpMetadata: { contentType: existing.contentType },
      httpEtag: existing.etag,
      uploaded: existing.uploaded,
      etag: existing.etag,
      key,
      size: existing.value.length,
      checksums: {
        md5: undefined,
        sha1: undefined,
        sha256: undefined,
        sha384: undefined,
        sha512: undefined,
      },
      version: "v1",
      writeHttpMetadata: () => {},
      writeChecksums: () => {},
      arrayBuffer: async () =>
        new TextEncoder().encode(existing.value).buffer as ArrayBuffer,
      text: async () => existing.value,
      json: async <T>() => JSON.parse(existing.value) as T,
      blob: async () => new Blob([existing.value]),
    };
  }

  async head(key: string): Promise<any> {
    const existing = this.objects.get(key);
    if (!existing) return null;
    return {
      httpEtag: existing.etag,
      etag: existing.etag,
      key,
      size: existing.value.length,
      uploaded: existing.uploaded,
    };
  }

  async put(
    key: string,
    value:
      string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream | null,
    options?: any,
  ): Promise<any> {
    const existing = this.objects.get(key);
    const onlyIf = options?.onlyIf;

    if (onlyIf && "etagDoesNotMatch" in onlyIf) {
      if (onlyIf.etagDoesNotMatch === "*" && existing) {
        return null;
      }
    }

    if (onlyIf && "etagMatches" in onlyIf) {
      if (!existing || existing.etag !== onlyIf.etagMatches) {
        return null;
      }
    }

    const asText = await this.toText(value);
    const uploaded = new Date();
    const metadata = options?.httpMetadata;
    const contentType =
      metadata &&
      typeof metadata === "object" &&
      "contentType" in metadata &&
      typeof (metadata as { contentType?: unknown }).contentType === "string"
        ? (metadata as { contentType: string }).contentType
        : "text/plain";

    const next: StoredObject = {
      value: asText,
      contentType,
      etag: this.createEtag(`${key}:${asText}:${uploaded.getTime()}`),
      uploaded,
    };
    this.objects.set(key, next);

    return {
      key,
      etag: next.etag,
      size: asText.length,
      uploaded,
      checksums: {
        md5: undefined,
        sha1: undefined,
        sha256: undefined,
        sha384: undefined,
        sha512: undefined,
      },
      httpEtag: next.etag,
      version: "v1",
      httpMetadata: { contentType: next.contentType },
      customMetadata: {},
      range: undefined,
      writeHttpMetadata: () => {},
      writeChecksums: () => {},
    };
  }

  async delete(keys: string | string[]): Promise<void> {
    if (Array.isArray(keys)) {
      keys.forEach((key) => this.objects.delete(key));
      return;
    }

    this.objects.delete(keys);
  }

  private createEtag(input: string): string {
    return createHash("sha1").update(input).digest("hex");
  }

  private async toText(
    value:
      string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream | null,
  ): Promise<string> {
    if (typeof value === "string") {
      return value;
    }

    if (value === null) {
      return "";
    }

    return await new Response(value as BodyInit).text();
  }
}

class RacingMemoryR2Bucket extends MemoryR2Bucket {
  private didRace = false;

  override async put(
    key: string,
    value: Parameters<MemoryR2Bucket["put"]>[1],
    options?: unknown,
  ): Promise<any> {
    if (!this.didRace && key === "RaceLock00005") {
      this.didRace = true;
      this.seed(key, "concurrent replacement", "text/plain");
    }
    return super.put(key, value, options);
  }
}

const createEnvelope = (accountId = "account-1"): DropEnvelope => ({
  createdAt: Date.now(),
  accountId,
  visibility: "unlisted",
  unlockPolicy: "provider-escrow",
  metadata: {},
  cipher: {
    alg: "A256GCM",
    iv: "iv",
    ciphertext: "cipher",
  },
  keyEnvelope: {
    mode: "account-vault-rsa-oaep",
    kid: "enc-kid",
    wrappedKey: "wrapped",
  },
  signatures: {
    device: {
      kid: "sig-kid",
      alg: "ECDSA_P256_SHA256",
      sig: "sig",
    },
  },
});

const serializeEnvelope = (envelope: DropEnvelope): string =>
  JSON.stringify(encodeDropEnvelope(envelope));

const toBase64Url = (value: ArrayBuffer): string => {
  let binary = "";
  new Uint8Array(value).forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

const createSignedOwnerEnvelope = async (accountId: string) => {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const signingPublicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const envelope = createEnvelope(accountId);
  envelope.deviceSignerPublicJwk = signingPublicJwk;
  envelope.signatures.device.sig = toBase64Url(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      pair.privateKey,
      new TextEncoder().encode(
        serializeDropEnvelopeForDeviceSignature(
          toDropEnvelopeSignable(envelope),
        ),
      ),
    ),
  );
  return { envelope, signingPublicJwk };
};

const createProviderSigningPrivateJwk = async (): Promise<JsonWebKey> => {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  return {
    ...(await crypto.subtle.exportKey("jwk", pair.privateKey)),
    kid: "provider-test",
  } as JsonWebKey;
};

const createStoreDatabase = (input?: {
  entry?: {
    entry_seq: number;
    drop_id: string;
    account_id: string;
    visibility: "private" | "unlisted" | "public";
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
  } | null;
  accounts?: Map<string, { account_id: string; signing_public_jwk: string }>;
}) => ({
  prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind: (...bound: unknown[]) => {
        values = bound;
        return statement;
      },
      first: async () => {
        if (sql.includes("FROM account_library_entries")) {
          return input?.entry ?? null;
        }
        if (sql.includes("FROM accounts")) {
          return input?.accounts?.get(String(values[0])) ?? null;
        }
        return null;
      },
      all: async () => ({ results: [] }),
      run: async () => ({ success: true }),
    };
    return statement;
  },
});

const createStoreRequest = (body: unknown, accountId?: string): Request => {
  const envelope =
    typeof body === "object" && body !== null && "envelope" in body
      ? (body as { envelope?: unknown }).envelope
      : null;
  const wireBody =
    envelope &&
    typeof envelope === "object" &&
    "createdAt" in envelope &&
    "signatures" in envelope
      ? {
          ...(body as Record<string, unknown>),
          envelope: encodeDropEnvelope(envelope as DropEnvelope),
        }
      : body;

  return new Request("https://nulldown.test/api/store", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accountId ? { "x-nulldown-account-id": accountId } : {}),
    },
    body: JSON.stringify(wireBody),
  });
};

const createDeleteRequest = (
  id: string,
  revision?: string,
  accountId?: string,
): Request =>
  new Request(`https://nulldown.test/api/delete/${id}`, {
    method: "DELETE",
    headers: {
      ...(revision ? { "If-Match": revision } : {}),
      ...(accountId ? { "x-nulldown-account-id": accountId } : {}),
    },
  });

describe("functions api conflict contracts", () => {
  let infoSpy: jest.SpiedFunction<typeof console.info>;
  let warnSpy: jest.SpiedFunction<typeof console.warn>;
  let errorSpy: jest.SpiedFunction<typeof console.error>;
  let debugSpy: jest.SpiedFunction<typeof console.debug>;

  beforeEach(() => {
    infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    debugSpy = jest.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it("returns 409 alias_conflict from /api/store as structured JSON", async () => {
    const bucket = new MemoryR2Bucket();
    const existingId = "AaBbCc112233";
    const requestedId = "AaBbCc445566";

    bucket.seed(createRemoteAliasKey("AaBbCc"), existingId, "text/plain");

    const response = await onStorePost({
      request: createStoreRequest({
        id: requestedId,
        upsert: false,
        envelope: { content: "alias collision" },
      }),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: createStoreDatabase() as never,
        PUBLIC_BASE_URL: "https://nulldown.test",
      },
    } as unknown as Parameters<typeof onStorePost>[0]);

    const body = (await response.json()) as {
      error: string;
      code: string;
      details?: Record<string, unknown>;
    };

    expect(response.status).toBe(409);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(body.code).toBe("alias_conflict");
    expect(body.error).toContain("already in use");
  });

  it("returns 412 revision_precondition_failed from /api/store as structured JSON", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "QweRty123456";
    const accountId = "account-owner";
    const { envelope, signingPublicJwk } =
      await createSignedOwnerEnvelope(accountId);

    bucket.seed(
      id,
      serializeEnvelope(createEnvelope(accountId)),
      "application/json",
    );
    bucket.seed(createRemoteAliasKey("QweRty"), id, "text/plain");
    const db = createStoreDatabase({
      entry: {
        entry_seq: 1,
        drop_id: id,
        account_id: accountId,
        visibility: "unlisted",
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      accounts: new Map([
        [
          accountId,
          {
            account_id: accountId,
            signing_public_jwk: JSON.stringify(signingPublicJwk),
            created_at: 1,
            updated_at: 1,
          },
        ],
      ]),
    });

    const response = await onStorePost({
      request: createStoreRequest(
        {
          id,
          upsert: true,
          expectedRevision: "mismatched-etag",
          envelope,
        },
        accountId,
      ),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as never,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
        PUBLIC_BASE_URL: "https://nulldown.test",
      },
    } as unknown as Parameters<typeof onStorePost>[0]);

    const body = (await response.json()) as {
      error: string;
      code: string;
      details?: Record<string, unknown>;
    };

    expect(response.status).toBe(412);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(body.code).toBe("revision_precondition_failed");
    expect(body.error).toContain("Refresh and try again");
  });

  it("fails closed when an existing root has no ownership projection despite a valid revision", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "QuoteRev1234";
    const original = serializeEnvelope(createEnvelope());

    const etag = bucket.seed(id, original, "application/json");
    bucket.seed(createRemoteAliasKey("QuoteR"), id, "text/plain");

    const response = await onStorePost({
      request: createStoreRequest({
        id,
        upsert: true,
        expectedRevision: `"${etag}"`,
        envelope: createEnvelope("account-2"),
      }),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: createStoreDatabase() as never,
        PUBLIC_BASE_URL: "https://nulldown.test",
      },
    } as unknown as Parameters<typeof onStorePost>[0]);

    const body = (await response.json()) as { code: string };

    expect(response.status).toBe(503);
    expect(body.code).toBe("account_library_unavailable");
    await expect((await bucket.get(id))?.text()).resolves.toBe(original);
  });

  it.each(["public", "unlisted"] as const)(
    "does not provider-sign an anonymous %s account envelope creation",
    async (visibility) => {
      const bucket = new MemoryR2Bucket();
      const id = `Anonymous${visibility}`;
      const envelope = createEnvelope("account-owner");
      envelope.visibility = visibility;
      const providerSigningPrivateJwk = await createProviderSigningPrivateJwk();

      const response = await onStorePost({
        request: createStoreRequest({ id, upsert: true, envelope }),
        env: {
          R2_BUCKET: bucket as unknown as R2Bucket,
          DB: createStoreDatabase() as never,
          PROVIDER_SIGNING_PRIVATE_JWK: JSON.stringify(
            providerSigningPrivateJwk,
          ),
          LOG_LEVEL: "debug",
          PUBLIC_BASE_URL: "https://nulldown.test",
        },
      } as unknown as Parameters<typeof onStorePost>[0]);

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({ code: "account_auth_required" }),
      );
      expect(debugSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('"event":"store.provider_signature_applied"'),
      );
      await expect(bucket.get(id)).resolves.toBeNull();
    },
  );

  it("allows a verified owner to create a provider-signed envelope", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "VerifiedCreate1";
    const accountId = "account-owner";
    const { envelope, signingPublicJwk } =
      await createSignedOwnerEnvelope(accountId);
    const providerSigningPrivateJwk = await createProviderSigningPrivateJwk();
    const db = createStoreDatabase({
      accounts: new Map([
        [
          accountId,
          {
            account_id: accountId,
            signing_public_jwk: JSON.stringify(signingPublicJwk),
            created_at: 1,
            updated_at: 1,
          },
        ],
      ]),
    });

    const response = await onStorePost({
      request: createStoreRequest({ id, upsert: true, envelope }, accountId),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as never,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
        PROVIDER_SIGNING_PRIVATE_JWK: JSON.stringify(providerSigningPrivateJwk),
        PUBLIC_BASE_URL: "https://nulldown.test",
      },
    } as unknown as Parameters<typeof onStorePost>[0]);

    expect(response.status).toBe(200);
    await expect((await bucket.get(id))?.json()).resolves.toMatchObject({
      schema: "nmdn.drop.v1",
      version: 1,
      accountId,
      signatures: {
        provider: {
          kid: "provider-test",
          alg: "ECDSA_P256_SHA256",
          sig: expect.any(String),
        },
      },
    });
  });

  it("rejects an anonymous unlisted envelope overwrite before replacing a protected root", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "ProtectedAnon01";
    const original = serializeEnvelope(createEnvelope("account-owner"));
    bucket.seed(id, original, "application/json");
    const db = createStoreDatabase({
      entry: {
        entry_seq: 1,
        drop_id: id,
        account_id: "account-owner",
        visibility: "unlisted",
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
    });

    const response = await onStorePost({
      request: createStoreRequest({
        id,
        upsert: true,
        envelope: createEnvelope("account-owner"),
      }),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as never,
        PUBLIC_BASE_URL: "https://nulldown.test",
      },
    } as unknown as Parameters<typeof onStorePost>[0]);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ code: "account_auth_required" }),
    );
    await expect((await bucket.get(id))?.text()).resolves.toBe(original);
  });

  it("rejects a plaintext overwrite of a protected root", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "ProtectedPlain02";
    const original = serializeEnvelope(createEnvelope("account-owner"));
    bucket.seed(id, original, "application/json");
    const db = createStoreDatabase({
      entry: {
        entry_seq: 1,
        drop_id: id,
        account_id: "account-owner",
        visibility: "unlisted",
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
    });

    const response = await onStorePost({
      request: createStoreRequest({
        id,
        upsert: true,
        envelope: { content: "replacement" },
      }),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as never,
        PUBLIC_BASE_URL: "https://nulldown.test",
      },
    } as unknown as Parameters<typeof onStorePost>[0]);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ code: "account_owned_envelope_required" }),
    );
    await expect((await bucket.get(id))?.text()).resolves.toBe(original);
  });

  it("fails closed when metadata is unavailable for an existing root upsert", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "ProtectedNoDb003";
    const original = serializeEnvelope(createEnvelope("account-owner"));
    bucket.seed(id, original, "application/json");

    const response = await onStorePost({
      request: createStoreRequest({
        id,
        upsert: true,
        envelope: createEnvelope("account-owner"),
      }),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        PUBLIC_BASE_URL: "https://nulldown.test",
      },
    } as unknown as Parameters<typeof onStorePost>[0]);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ code: "account_library_unavailable" }),
    );
    await expect((await bucket.get(id))?.text()).resolves.toBe(original);
  });

  it("allows a verified owner to replace a protected root", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "ProtectedOwner4";
    const accountId = "account-owner";
    const original = serializeEnvelope(createEnvelope(accountId));
    const etag = bucket.seed(id, original, "application/json");
    const { envelope, signingPublicJwk } =
      await createSignedOwnerEnvelope(accountId);
    const providerSigningPrivateJwk = await createProviderSigningPrivateJwk();
    const db = createStoreDatabase({
      entry: {
        entry_seq: 1,
        drop_id: id,
        account_id: accountId,
        visibility: "unlisted",
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      accounts: new Map([
        [
          accountId,
          {
            account_id: accountId,
            signing_public_jwk: JSON.stringify(signingPublicJwk),
            created_at: 1,
            updated_at: 1,
          },
        ],
      ]),
    });

    const response = await onStorePost({
      request: createStoreRequest(
        { id, upsert: true, expectedRevision: etag, envelope },
        accountId,
      ),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as never,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
        PROVIDER_SIGNING_PRIVATE_JWK: JSON.stringify(providerSigningPrivateJwk),
        PUBLIC_BASE_URL: "https://nulldown.test",
      },
    } as unknown as Parameters<typeof onStorePost>[0]);

    expect(response.status).toBe(200);
    await expect((await bucket.get(id))?.json()).resolves.toMatchObject({
      accountId,
      signatures: {
        device: expect.any(Object),
        provider: expect.objectContaining({ kid: "provider-test" }),
      },
    });
  });

  it("rejects a verified non-owner before replacing a protected root", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "ProtectedForeign";
    const ownerAccountId = "account-owner";
    const foreignAccountId = "account-foreign";
    const original = serializeEnvelope(createEnvelope(ownerAccountId));
    bucket.seed(id, original, "application/json");
    const { envelope, signingPublicJwk } =
      await createSignedOwnerEnvelope(foreignAccountId);
    const db = createStoreDatabase({
      entry: {
        entry_seq: 1,
        drop_id: id,
        account_id: ownerAccountId,
        visibility: "unlisted",
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      accounts: new Map([
        [
          foreignAccountId,
          {
            account_id: foreignAccountId,
            signing_public_jwk: JSON.stringify(signingPublicJwk),
            created_at: 1,
            updated_at: 1,
          },
        ],
      ]),
    });

    const response = await onStorePost({
      request: createStoreRequest(
        { id, upsert: true, envelope },
        foreignAccountId,
      ),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as never,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
        PUBLIC_BASE_URL: "https://nulldown.test",
      },
    } as unknown as Parameters<typeof onStorePost>[0]);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ code: "account_mismatch" }),
    );
    await expect((await bucket.get(id))?.text()).resolves.toBe(original);
  });

  it("does not overwrite a root that changes after its ownership check", async () => {
    const bucket = new RacingMemoryR2Bucket();
    const id = "RaceLock00005";
    const accountId = "account-owner";
    const original = serializeEnvelope(createEnvelope(accountId));
    bucket.seed(id, original, "application/json");
    const { envelope, signingPublicJwk } =
      await createSignedOwnerEnvelope(accountId);
    const db = createStoreDatabase({
      entry: {
        entry_seq: 1,
        drop_id: id,
        account_id: accountId,
        visibility: "unlisted",
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      accounts: new Map([
        [
          accountId,
          {
            account_id: accountId,
            signing_public_jwk: JSON.stringify(signingPublicJwk),
            created_at: 1,
            updated_at: 1,
          },
        ],
      ]),
    });

    const response = await onStorePost({
      request: createStoreRequest({ id, upsert: true, envelope }, accountId),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as never,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
        PUBLIC_BASE_URL: "https://nulldown.test",
      },
    } as unknown as Parameters<typeof onStorePost>[0]);

    expect(response.status).toBe(412);
    await expect((await bucket.get(id))?.text()).resolves.toBe(
      "concurrent replacement",
    );
  });

  it("requires the tombstoned owner to recreate a deleted root", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "ProtectedTomb06";
    const ownerAccountId = "account-owner";
    const foreignAccountId = "account-foreign";
    const { envelope, signingPublicJwk } =
      await createSignedOwnerEnvelope(foreignAccountId);
    const db = createStoreDatabase({
      entry: {
        entry_seq: 1,
        drop_id: id,
        account_id: ownerAccountId,
        visibility: "unlisted",
        created_at: 1,
        updated_at: 1,
        deleted_at: 2,
      },
      accounts: new Map([
        [
          foreignAccountId,
          {
            account_id: foreignAccountId,
            signing_public_jwk: JSON.stringify(signingPublicJwk),
            created_at: 1,
            updated_at: 1,
          },
        ],
      ]),
    });

    const response = await onStorePost({
      request: createStoreRequest(
        { id, upsert: true, envelope },
        foreignAccountId,
      ),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as never,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
        PUBLIC_BASE_URL: "https://nulldown.test",
      },
    } as unknown as Parameters<typeof onStorePost>[0]);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ code: "account_mismatch" }),
    );
    await expect(bucket.get(id)).resolves.toBeNull();
  });

  it("allows a verified owner to reclaim a tombstoned root", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "TombOwner0007";
    const accountId = "account-owner";
    const { envelope, signingPublicJwk } =
      await createSignedOwnerEnvelope(accountId);
    const db = createStoreDatabase({
      entry: {
        entry_seq: 1,
        drop_id: id,
        account_id: accountId,
        visibility: "unlisted",
        created_at: 1,
        updated_at: 1,
        deleted_at: 2,
      },
      accounts: new Map([
        [
          accountId,
          {
            account_id: accountId,
            signing_public_jwk: JSON.stringify(signingPublicJwk),
            created_at: 1,
            updated_at: 1,
          },
        ],
      ]),
    });

    const response = await onStorePost({
      request: createStoreRequest({ id, upsert: true, envelope }, accountId),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as never,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
        PUBLIC_BASE_URL: "https://nulldown.test",
      },
    } as unknown as Parameters<typeof onStorePost>[0]);

    expect(response.status).toBe(200);
    await expect((await bucket.get(id))?.json()).resolves.toMatchObject({
      accountId,
    });
  });

  it("rejects an empty bearer token for an unlisted envelope", async () => {
    const bucket = new MemoryR2Bucket();
    const request = createStoreRequest({
      envelope: createEnvelope("account-owner"),
    });
    request.headers.set("Authorization", "Bearer");

    const response = await onStorePost({
      request,
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: createStoreDatabase() as never,
        PUBLIC_BASE_URL: "https://nulldown.test",
      },
    } as unknown as Parameters<typeof onStorePost>[0]);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ code: "account_auth_required" }),
    );
  });

  it("returns 412 revision_precondition_failed from /api/delete/:id as structured JSON", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "ZxCvBn123456";
    bucket.seed(id, "drop body", "text/plain");
    const db = createStoreDatabase({
      entry: {
        entry_seq: 1,
        drop_id: id,
        account_id: "account-owner",
        visibility: "unlisted",
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
    });

    const response = await onRequestDelete({
      request: createDeleteRequest(id, "wrong-revision", "account-owner"),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as never,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {
        id,
      },
    } as unknown as Parameters<typeof onRequestDelete>[0]);

    const body = (await response.json()) as {
      error: string;
      code: string;
      details?: Record<string, unknown>;
    };

    expect(response.status).toBe(412);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(body.code).toBe("revision_precondition_failed");
    expect(body.error).toContain("Refresh and try again");
    expect(await bucket.get(id)).not.toBeNull();
  });

  it("requires an authenticated owner and revision before deleting a projected root", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "DeleteGuard001";
    const etag = bucket.seed(id, "drop body", "text/plain");
    const db = createStoreDatabase({
      entry: {
        entry_seq: 1,
        drop_id: id,
        account_id: "account-owner",
        visibility: "unlisted",
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
    });
    const env = {
      R2_BUCKET: bucket as unknown as R2Bucket,
      DB: db as never,
      ALLOW_INSECURE_ACCOUNT_HEADER: "1",
    };

    const anonymous = await onRequestDelete({
      request: createDeleteRequest(id, etag),
      env,
      params: { id },
    } as unknown as Parameters<typeof onRequestDelete>[0]);
    const foreign = await onRequestDelete({
      request: createDeleteRequest(id, etag, "account-foreign"),
      env,
      params: { id },
    } as unknown as Parameters<typeof onRequestDelete>[0]);
    const missingRevision = await onRequestDelete({
      request: createDeleteRequest(id, undefined, "account-owner"),
      env,
      params: { id },
    } as unknown as Parameters<typeof onRequestDelete>[0]);

    expect(anonymous.status).toBe(401);
    expect(foreign.status).toBe(404);
    expect(missingRevision.status).toBe(428);
    await expect(bucket.get(id)).resolves.not.toBeNull();
  });

  it("deletes only an active projected root owned at the supplied revision", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "DeleteOwner002";
    const etag = bucket.seed(id, "drop body", "text/plain");
    const db = createStoreDatabase({
      entry: {
        entry_seq: 1,
        drop_id: id,
        account_id: "account-owner",
        visibility: "unlisted",
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
    });

    const response = await onRequestDelete({
      request: createDeleteRequest(id, `"${etag}"`, "account-owner"),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as never,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: { id },
    } as unknown as Parameters<typeof onRequestDelete>[0]);

    expect(response.status).toBe(204);
    await expect(bucket.get(id)).resolves.toBeNull();
  });

  it("fails closed when account-library storage is unavailable for deletion", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "DeleteNoDb0003";
    const etag = bucket.seed(id, "drop body", "text/plain");

    const response = await onRequestDelete({
      request: createDeleteRequest(id, etag, "account-owner"),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: { id },
    } as unknown as Parameters<typeof onRequestDelete>[0]);

    expect(response.status).toBe(503);
    await expect(bucket.get(id)).resolves.not.toBeNull();
  });

  it("serializes protected root writers and deleters through one root lease", async () => {
    const bucket = new MemoryR2Bucket();
    const first = await acquireRootMutationLock(
      bucket as never,
      "DeleteLock004",
    );
    let acquiredSecond = false;
    const secondPromise = acquireRootMutationLock(
      bucket as never,
      "DeleteLock004",
    ).then((lock) => {
      acquiredSecond = true;
      return lock;
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(acquiredSecond).toBe(false);

    await first.release();
    const second = await secondPromise;
    expect(acquiredSecond).toBe(true);
    await second.release();
  });

  it("rejects a stale root mutation after another actor takes over its lease", async () => {
    const bucket = new MemoryR2Bucket();
    const now = Date.now();
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(now);
    const first = await acquireRootMutationLock(
      bucket as never,
      "DeleteLock005",
    );
    nowSpy.mockReturnValue(now + 300_001);
    const second = await acquireRootMutationLock(
      bucket as never,
      "DeleteLock005",
    );

    await expect(first.beginCommit()).rejects.toMatchObject({
      code: "root_mutation_lock_lost",
    });
    nowSpy.mockRestore();
    await first.release();
    await second.release();
  });

  it("tombstones a root before a failed metadata cleanup can leave it readable", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "DeleteTomb005";
    const etag = bucket.seed(id, "drop body", "text/plain");
    const entry = {
      entry_seq: 1,
      drop_id: id,
      account_id: "account-owner",
      visibility: "unlisted" as const,
      created_at: 1,
      updated_at: 1,
      deleted_at: null as number | null,
    };
    const db = {
      prepare(sql: string) {
        const statement = {
          bind: () => statement,
          first: async () =>
            sql.includes("FROM account_library_entries") ? entry : null,
          all: async () => ({ results: [] }),
          run: async () => {
            if (sql.includes("UPDATE account_library_entries")) {
              entry.deleted_at = Date.now();
              return { success: true };
            }
            if (sql.includes("DELETE FROM drops")) {
              throw new Error("metadata cleanup failed");
            }
            return { success: true };
          },
        };
        return statement;
      },
    };
    const env = {
      R2_BUCKET: bucket as unknown as R2Bucket,
      DB: db as never,
      ALLOW_INSECURE_ACCOUNT_HEADER: "1",
    };

    const response = await onRequestDelete({
      request: createDeleteRequest(id, etag, "account-owner"),
      env,
      params: { id },
    } as unknown as Parameters<typeof onRequestDelete>[0]);
    const read = await onRequestGet({
      request: new Request(`https://nulldown.test/api/get/${id}`),
      env,
      params: { id },
    } as unknown as Parameters<typeof onRequestGet>[0]);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ error: "Failed to delete drop." }),
    );
    expect(entry.deleted_at).not.toBeNull();
    await expect(bucket.get(id)).resolves.not.toBeNull();
    expect(read.status).toBe(404);
  });

  it("keeps projected public and unlisted links readable while private links remain account-gated", async () => {
    const bucket = new MemoryR2Bucket();
    bucket.seed("PublicLink123", "public body", "text/plain");

    const read = async (visibility: "private" | "unlisted" | "public") => {
      const db = {
        prepare: jest.fn(() => ({
          bind: jest.fn().mockReturnThis(),
          first: jest.fn().mockResolvedValue({
            entry_seq: 1,
            drop_id: "PublicLink123",
            account_id: "account-1",
            visibility,
            created_at: 1,
            updated_at: 1,
            deleted_at: null,
          }),
        })),
      };
      return onRequestGet({
        request: new Request("https://nulldown.test/api/get/PublicLink123"),
        env: { R2_BUCKET: bucket as unknown as R2Bucket, DB: db },
        params: { id: "PublicLink123" },
      } as unknown as Parameters<typeof onRequestGet>[0]);
    };

    await expect(read("public")).resolves.toHaveProperty("status", 200);
    await expect(read("unlisted")).resolves.toHaveProperty("status", 200);
    await expect(read("private")).resolves.toHaveProperty("status", 404);
  });
});

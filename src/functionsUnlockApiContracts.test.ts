import {
  createHash,
  webcrypto,
  type webcrypto as NodeWebCrypto,
} from "node:crypto";
import { jest } from "@jest/globals";
import type { R2Bucket } from "@cloudflare/workers-types";
import { onRequestPost } from "../functions/api/unlock/[id]";
import { issueAccountSessionToken } from "../functions/api/_lib/accounts/session/auth";
import { providerCrypto } from "../functions/api/_lib/crypto/provider-crypto";
import { createRemoteAliasKey } from "../functions/api/_lib/drops/identity/id";
import {
  canReadRoot,
  type RootReadAuthorizationDecision,
} from "../functions/api/_lib/security/readAuthorization";
import { encodeDropEnvelope } from "../shared/drop/codecs/envelope-v1";
import type { DropEnvelope } from "../shared/drop/types";
import type {
  VoidSqlBindableValue,
  VoidSqlStatement,
  VoidSqlStore,
} from "./server/ports";

interface StoredObject {
  value: string;
  contentType: string;
  etag: string;
  uploaded: Date;
}

class MemoryR2Bucket {
  private readonly objects = new Map<string, StoredObject>();
  rootReads = 0;
  aliasReads = 0;

  seed(key: string, value: string, contentType = "application/json"): void {
    const uploaded = new Date();
    this.objects.set(key, {
      value,
      contentType,
      etag: createHash("sha1")
        .update(`${key}:${value}:${uploaded.getTime()}`)
        .digest("hex"),
      uploaded,
    });
  }

  async get(key: string): Promise<any> {
    if (key.startsWith("__drop_alias__/")) this.aliasReads += 1;
    else this.rootReads += 1;
    const existing = this.objects.get(key);
    if (!existing) return null;

    return {
      body: new Response(existing.value).body,
      httpMetadata: { contentType: existing.contentType },
      httpEtag: existing.etag,
      uploaded: existing.uploaded,
      etag: existing.etag,
      key,
      size: existing.value.length,
      text: async () => existing.value,
      json: async <T>() => JSON.parse(existing.value) as T,
    };
  }
}

interface ProjectionRow {
  entry_seq: number;
  drop_id: string;
  account_id: string;
  visibility: unknown;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

class ProjectionDatabase implements VoidSqlStore {
  runs = 0;
  aliasReads = 0;
  projectionReads = 0;

  constructor(
    private readonly rows = new Map<string, ProjectionRow>(),
    private readonly aliases = new Map<string, string>(),
  ) {}

  prepare(sql: string): VoidSqlStatement {
    let values: VoidSqlBindableValue[] = [];
    const statement: VoidSqlStatement = {
      bind: (...bound) => {
        values = bound;
        return statement;
      },
      run: async () => {
        this.runs += 1;
        return { success: true };
      },
      first: async <T>() => {
        if (sql.includes("FROM drop_aliases")) {
          this.aliasReads += 1;
          const fullId = this.aliases.get(String(values[0]));
          return fullId ? ({ full_id: fullId } as T) : null;
        }
        if (sql.includes("FROM account_library_entries")) {
          this.projectionReads += 1;
          return (this.rows.get(String(values[0])) as T | undefined) ?? null;
        }
        return null;
      },
      all: async <T>() => ({ results: [] as T[] }),
    };
    return statement;
  }
}

const projection = (
  dropId: string,
  visibility: unknown,
  accountId = "account-link-only",
  deletedAt: number | null = null,
): ProjectionRow => ({
  entry_seq: 1,
  drop_id: dropId,
  account_id: accountId,
  visibility,
  created_at: 1,
  updated_at: 1,
  deleted_at: deletedAt,
});

interface UnlockFixture {
  accountId: string;
  envelope: DropEnvelope;
  plaintext: string;
  providerPrivateJwk: JsonWebKey;
  providerPrivateJwkJson: string;
  rawContentKey: ArrayBuffer;
  requesterPrivateKey: NodeCryptoKey;
  requesterPublicJwk: JsonWebKey;
  vaultKeyId: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
type NodeCryptoKey = NodeWebCrypto.CryptoKey;
type NodeCryptoKeyPair = NodeWebCrypto.CryptoKeyPair;

const toArrayBuffer = (value: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
};

const toBase64 = (value: ArrayBuffer | Uint8Array): string =>
  Buffer.from(
    value instanceof Uint8Array ? value : new Uint8Array(value),
  ).toString("base64");

const fromBase64 = (value: string): Uint8Array =>
  new Uint8Array(Buffer.from(value, "base64"));

const generateRsaOaepKeyPair = async (): Promise<NodeCryptoKeyPair> =>
  (await webcrypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  )) as NodeCryptoKeyPair;

const createFixture = async (): Promise<UnlockFixture> => {
  const providerKeyPair = await generateRsaOaepKeyPair();
  const requesterKeyPair = await generateRsaOaepKeyPair();
  const providerPrivateJwk = (await webcrypto.subtle.exportKey(
    "jwk",
    providerKeyPair.privateKey,
  )) as unknown as JsonWebKey;
  const requesterPublicJwk = (await webcrypto.subtle.exportKey(
    "jwk",
    requesterKeyPair.publicKey,
  )) as unknown as JsonWebKey;
  const rawContentKeyBytes = webcrypto.getRandomValues(new Uint8Array(32));
  const rawContentKey = toArrayBuffer(rawContentKeyBytes);
  const contentKey = await webcrypto.subtle.importKey(
    "raw",
    rawContentKey,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const plaintext = "link access returns no plaintext content";
  const ciphertext = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    contentKey,
    toArrayBuffer(textEncoder.encode(plaintext)),
  );
  const providerWrappedContentKey = await webcrypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    providerKeyPair.publicKey,
    rawContentKey,
  );
  const accountId = "account-link-only";
  const vaultKeyId = "vault-key-must-not-leak";

  return {
    accountId,
    plaintext,
    providerPrivateJwk,
    providerPrivateJwkJson: JSON.stringify(providerPrivateJwk),
    rawContentKey,
    requesterPrivateKey: requesterKeyPair.privateKey,
    requesterPublicJwk,
    vaultKeyId,
    envelope: {
      createdAt: Date.now(),
      accountId,
      visibility: "unlisted",
      unlockPolicy: "provider-escrow",
      metadata: {},
      cipher: {
        alg: "A256GCM",
        iv: toBase64(iv),
        ciphertext: toBase64(ciphertext),
      },
      keyEnvelope: {
        mode: "account-vault-rsa-oaep",
        kid: vaultKeyId,
        wrappedKey: "vault-wrapped-key-must-not-leak",
      },
      providerEscrow: {
        mode: "provider-rsa-oaep",
        kid: "provider-key",
        wrappedKey: toBase64(providerWrappedContentKey),
      },
      signatures: {
        device: {
          kid: "device-key",
          alg: "ECDSA_P256_SHA256",
          sig: "signature-not-used-by-link-access",
        },
      },
    },
  };
};

const createRequest = (
  requesterPublicJwk: JsonWebKey,
  headers: Record<string, string> = {},
): Request =>
  new Request("https://nulldown.test/api/unlock/drop", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ requesterPublicJwk }),
  });

const callUnlock = async (
  bucket: MemoryR2Bucket,
  id: string,
  requesterPublicJwk: JsonWebKey,
  providerPrivateJwk?: string,
  options: {
    db?: VoidSqlStore;
    headers?: Record<string, string>;
    env?: Record<string, string>;
  } = {},
): Promise<Response> =>
  onRequestPost({
    request: createRequest(requesterPublicJwk, options.headers),
    env: {
      R2_BUCKET: bucket as unknown as R2Bucket,
      PROVIDER_ENCRYPTION_PRIVATE_JWK: providerPrivateJwk,
      DB: options.db,
      ...options.env,
    },
    params: { id },
  } as unknown as Parameters<typeof onRequestPost>[0]);

const seedLinkedEnvelope = (
  bucket: MemoryR2Bucket,
  shortId: string,
  fullId: string,
  envelope: DropEnvelope,
): void => {
  bucket.seed(createRemoteAliasKey(shortId), fullId, "text/plain");
  bucket.seed(fullId, JSON.stringify(encodeDropEnvelope(envelope)));
};

const expectNoSensitiveResponseMaterial = (
  responseText: string,
  fixture: UnlockFixture,
): void => {
  expect(responseText).not.toContain(fixture.plaintext);
  expect(responseText).not.toContain(fixture.accountId);
  expect(responseText).not.toContain(fixture.vaultKeyId);
  expect(responseText).not.toContain(fixture.providerPrivateJwkJson);
  expect(responseText).not.toContain(fixture.providerPrivateJwk.d ?? "");
};

describe("provider escrow link access contracts", () => {
  let fixture: UnlockFixture;
  let infoSpy: jest.SpiedFunction<typeof console.info>;
  let warnSpy: jest.SpiedFunction<typeof console.warn>;
  let errorSpy: jest.SpiedFunction<typeof console.error>;

  beforeAll(async () => {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: webcrypto,
    });
    fixture = await createFixture();
  });

  beforeEach(() => {
    infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it.each<[RootReadAuthorizationDecision, boolean]>([
    [{ kind: "identifier-readable" }, true],
    [{ kind: "private", accountId: "owner", isCanonicalOwner: true }, true],
    [{ kind: "private", accountId: "writer", isCanonicalOwner: false }, false],
    [{ kind: "denied" }, false],
  ])("makes a pure root decision for %j", (decision, allowed) => {
    expect(canReadRoot(decision)).toBe(allowed);
  });

  it("unauthenticated link requester gets only requester-wrapped content key and can decrypt it", async () => {
    const bucket = new MemoryR2Bucket();
    const shortId = "Link01";
    const fullId = "Link01AbCdEf";
    seedLinkedEnvelope(bucket, shortId, fullId, fixture.envelope);

    const request = createRequest(fixture.requesterPublicJwk);
    expect(request.headers.has("x-nulldown-account-id")).toBe(false);
    const response = await onRequestPost({
      request,
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        PROVIDER_ENCRYPTION_PRIVATE_JWK: fixture.providerPrivateJwkJson,
      },
      params: { id: shortId },
    } as unknown as Parameters<typeof onRequestPost>[0]);
    const responseText = await response.text();
    const body = JSON.parse(responseText) as { wrappedKey: string };

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(body).toEqual({ wrappedKey: expect.any(String) });
    expectNoSensitiveResponseMaterial(responseText, fixture);

    const requesterRawContentKey = await webcrypto.subtle.decrypt(
      { name: "RSA-OAEP" },
      fixture.requesterPrivateKey,
      fromBase64(body.wrappedKey),
    );
    expect(new Uint8Array(requesterRawContentKey)).toEqual(
      new Uint8Array(fixture.rawContentKey),
    );

    const contentKey = await webcrypto.subtle.importKey(
      "raw",
      requesterRawContentKey,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    const plaintext = await webcrypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64(fixture.envelope.cipher.iv),
      },
      contentKey,
      fromBase64(fixture.envelope.cipher.ciphertext),
    );
    expect(textDecoder.decode(plaintext)).toBe(fixture.plaintext);
  });

  it.each(["public", "unlisted"] as const)(
    "allows anonymous projected %s unlock",
    async (visibility) => {
      const id = visibility === "public" ? "PublicRoot01" : "UnlistRoot01";
      const bucket = new MemoryR2Bucket();
      bucket.seed(
        id,
        JSON.stringify(encodeDropEnvelope({ ...fixture.envelope, visibility })),
      );
      const db = new ProjectionDatabase(
        new Map([[id, projection(id, visibility)]]),
      );

      const response = await callUnlock(
        bucket,
        id,
        fixture.requesterPublicJwk,
        fixture.providerPrivateJwkJson,
        { db },
      );

      expect(response.status).toBe(200);
      expect(db.projectionReads).toBe(1);
    },
  );

  it("allows the projected private owner with the development credential", async () => {
    const id = "PrivateRoot01";
    const bucket = new MemoryR2Bucket();
    bucket.seed(
      id,
      JSON.stringify(
        encodeDropEnvelope({ ...fixture.envelope, visibility: "private" }),
      ),
    );
    const db = new ProjectionDatabase(
      new Map([[id, projection(id, "private")]]),
    );

    const response = await callUnlock(
      bucket,
      id,
      fixture.requesterPublicJwk,
      fixture.providerPrivateJwkJson,
      {
        db,
        headers: { "x-nulldown-account-id": fixture.accountId },
        env: { ALLOW_INSECURE_ACCOUNT_HEADER: "1" },
      },
    );

    expect(response.status).toBe(200);
  });

  it("allows the projected private owner with a bearer credential", async () => {
    const id = "BearerRoot01";
    const secret = "unlock-test-secret";
    const { token } = await issueAccountSessionToken(fixture.accountId, {
      ACCOUNT_AUTH_SECRET: secret,
    });
    const bucket = new MemoryR2Bucket();
    bucket.seed(
      id,
      JSON.stringify(
        encodeDropEnvelope({ ...fixture.envelope, visibility: "private" }),
      ),
    );
    const db = new ProjectionDatabase(
      new Map([[id, projection(id, "private")]]),
    );

    const response = await callUnlock(
      bucket,
      id,
      fixture.requesterPublicJwk,
      fixture.providerPrivateJwkJson,
      {
        db,
        headers: { Authorization: `Bearer ${token}` },
        env: { ACCOUNT_AUTH_SECRET: secret },
      },
    );

    expect(response.status).toBe(200);
  });

  it.each([
    ["anonymous", {}],
    ["unrelated", { "x-nulldown-account-id": "account-unrelated" }],
    ["branch-writer-only", { "x-nulldown-account-id": "account-writer" }],
  ])(
    "denies private %s access with the exact generic 404",
    async (_label, headers) => {
      const id = "DeniedRoot01";
      const bucket = new MemoryR2Bucket();
      bucket.seed(
        id,
        JSON.stringify(
          encodeDropEnvelope({ ...fixture.envelope, visibility: "private" }),
        ),
      );
      const db = new ProjectionDatabase(
        new Map([[id, projection(id, "private")]]),
      );

      const response = await callUnlock(
        bucket,
        id,
        fixture.requesterPublicJwk,
        fixture.providerPrivateJwkJson,
        {
          db,
          headers,
          env: { ALLOW_INSECURE_ACCOUNT_HEADER: "1" },
        },
      );

      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Drop not found.");
      expect(bucket.rootReads).toBe(0);
    },
  );

  it.each(["public", "unlisted", "private"])(
    "denies tombstoned %s projections",
    async (visibility) => {
      const id = `Tomb${visibility.slice(0, 4)}01`;
      const bucket = new MemoryR2Bucket();
      bucket.seed(id, JSON.stringify(encodeDropEnvelope(fixture.envelope)));
      const db = new ProjectionDatabase(
        new Map([[id, projection(id, visibility, fixture.accountId, 2)]]),
      );
      const response = await callUnlock(
        bucket,
        id,
        fixture.requesterPublicJwk,
        fixture.providerPrivateJwkJson,
        {
          db,
          headers: { "x-nulldown-account-id": fixture.accountId },
          env: { ALLOW_INSECURE_ACCOUNT_HEADER: "1" },
        },
      );

      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Drop not found.");
      expect(bucket.rootReads).toBe(0);
    },
  );

  it("denies malformed projected visibility", async () => {
    const id = "BadVisRoot01";
    const bucket = new MemoryR2Bucket();
    bucket.seed(id, JSON.stringify(encodeDropEnvelope(fixture.envelope)));
    const db = new ProjectionDatabase(
      new Map([[id, projection(id, "friends")]]),
    );
    const response = await callUnlock(
      bucket,
      id,
      fixture.requesterPublicJwk,
      fixture.providerPrivateJwkJson,
      { db },
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Drop not found.");
    expect(bucket.rootReads).toBe(0);
  });

  it("retains projection-absent legacy unlock behavior", async () => {
    const id = "LegacyRoot01";
    const bucket = new MemoryR2Bucket();
    bucket.seed(id, JSON.stringify(encodeDropEnvelope(fixture.envelope)));
    const db = new ProjectionDatabase();

    const response = await callUnlock(
      bucket,
      id,
      fixture.requesterPublicJwk,
      fixture.providerPrivateJwkJson,
      { db },
    );

    expect(response.status).toBe(200);
    expect(db.projectionReads).toBe(1);
  });

  it("does not fall back to the development credential for a mixed-case invalid bearer", async () => {
    const id = "BadBearRoot1";
    const bucket = new MemoryR2Bucket();
    bucket.seed(id, JSON.stringify(encodeDropEnvelope(fixture.envelope)));
    const db = new ProjectionDatabase(
      new Map([[id, projection(id, "private")]]),
    );
    const response = await callUnlock(
      bucket,
      id,
      fixture.requesterPublicJwk,
      fixture.providerPrivateJwkJson,
      {
        db,
        headers: {
          Authorization: "bEaReR invalid",
          "x-nulldown-account-id": fixture.accountId,
        },
        env: {
          ACCOUNT_AUTH_SECRET: "unlock-test-secret",
          ALLOW_INSECURE_ACCOUNT_HEADER: "1",
        },
      },
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Drop not found.");
    expect(bucket.rootReads).toBe(0);
  });

  it("resolves an R2-only short alias without SQL writes", async () => {
    const shortId = "R2Only";
    const fullId = "R2OnlyRoot01";
    const bucket = new MemoryR2Bucket();
    seedLinkedEnvelope(bucket, shortId, fullId, fixture.envelope);
    const db = new ProjectionDatabase(
      new Map([[fullId, projection(fullId, "unlisted")]]),
    );

    const response = await callUnlock(
      bucket,
      shortId,
      fixture.requesterPublicJwk,
      fixture.providerPrivateJwkJson,
      { db },
    );

    expect(response.status).toBe(200);
    expect(db.runs).toBe(0);
    expect(db.aliasReads).toBe(1);
    expect(bucket.aliasReads).toBe(1);
  });

  it("denies before body parsing, provider configuration, root reads, and crypto", async () => {
    const id = "EarlyDeny001";
    const bucket = new MemoryR2Bucket();
    bucket.seed(id, JSON.stringify(encodeDropEnvelope(fixture.envelope)));
    const db = new ProjectionDatabase(
      new Map([[id, projection(id, "private")]]),
    );
    const request = createRequest(fixture.requesterPublicJwk);
    const jsonSpy = jest.spyOn(request, "json");
    const cryptoSpies = [
      jest.spyOn(providerCrypto, "importProviderPrivateKey"),
      jest.spyOn(providerCrypto, "importRequesterPublicKey"),
      jest.spyOn(providerCrypto, "decryptProviderWrappedContentKey"),
      jest.spyOn(providerCrypto, "wrapRawContentKeyWithRequesterPublicKey"),
    ];

    const response = await onRequestPost({
      request,
      env: { R2_BUCKET: bucket as unknown as R2Bucket, DB: db },
      params: { id },
    } as unknown as Parameters<typeof onRequestPost>[0]);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Drop not found.");
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(bucket.rootReads).toBe(0);
    cryptoSpies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
  });

  it.each(["bad id", ""])("retains invalid ID behavior for %j", async (id) => {
    const response = await callUnlock(
      new MemoryR2Bucket(),
      id,
      fixture.requesterPublicJwk,
      fixture.providerPrivateJwkJson,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Drop ID is required.");
  });

  it("vault-only rejects even with valid requester key", async () => {
    const bucket = new MemoryR2Bucket();
    const shortId = "Vault1";
    const fullId = "Vault1AbCdEf";
    const envelope: DropEnvelope = {
      ...fixture.envelope,
      unlockPolicy: "vault-only",
      providerEscrow: undefined,
    };
    seedLinkedEnvelope(bucket, shortId, fullId, envelope);

    const response = await callUnlock(
      bucket,
      shortId,
      fixture.requesterPublicJwk,
      fixture.providerPrivateJwkJson,
    );
    const responseText = await response.text();

    expect(response.status).toBe(403);
    expect(responseText).toContain("does not allow provider escrow unlock");
    expect(responseText).not.toContain("wrappedKey");
    expectNoSensitiveResponseMaterial(responseText, fixture);
  });

  it("tampered provider wrapper fails closed", async () => {
    const bucket = new MemoryR2Bucket();
    const shortId = "Tamp01";
    const fullId = "Tamp01AbCdEf";
    const tamperedBytes = fromBase64(
      fixture.envelope.providerEscrow!.wrappedKey,
    );
    tamperedBytes[0] ^= 0xff;
    const envelope: DropEnvelope = {
      ...fixture.envelope,
      providerEscrow: {
        ...fixture.envelope.providerEscrow!,
        wrappedKey: toBase64(tamperedBytes),
      },
    };
    seedLinkedEnvelope(bucket, shortId, fullId, envelope);

    const response = await callUnlock(
      bucket,
      shortId,
      fixture.requesterPublicJwk,
      fixture.providerPrivateJwkJson,
    );
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(responseText).toBe("Failed to unlock drop.");
    expect(responseText).not.toContain("wrappedKey");
    expectNoSensitiveResponseMaterial(responseText, fixture);
  });

  it("invalid requester JWK rejected", async () => {
    const bucket = new MemoryR2Bucket();
    const shortId = "ReqJ01";
    const fullId = "ReqJ01AbCdEf";
    seedLinkedEnvelope(bucket, shortId, fullId, fixture.envelope);

    const response = await callUnlock(
      bucket,
      shortId,
      { kty: "RSA", n: "not-a-real-key" },
      fixture.providerPrivateJwkJson,
    );
    const responseText = await response.text();

    expect(response.status).toBe(400);
    expect(responseText).toContain("requesterPublicJwk is invalid");
    expect(responseText).not.toContain("wrappedKey");
    expectNoSensitiveResponseMaterial(responseText, fixture);
  });

  it("missing provider private key 501", async () => {
    const response = await callUnlock(
      new MemoryR2Bucket(),
      "NoKey1",
      fixture.requesterPublicJwk,
    );
    const responseText = await response.text();

    expect(response.status).toBe(501);
    expect(responseText).toContain("Provider escrow key is not configured");
    expect(responseText).not.toContain("wrappedKey");
    expectNoSensitiveResponseMaterial(responseText, fixture);
  });

  it("invalid provider private key retains the authorized 500 response", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "BadKeyRoot01";
    bucket.seed(id, JSON.stringify(encodeDropEnvelope(fixture.envelope)));

    const response = await callUnlock(
      bucket,
      id,
      fixture.requesterPublicJwk,
      "not-json",
    );
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(responseText).toBe("Provider escrow key is invalid.");
    expectNoSensitiveResponseMaterial(responseText, fixture);
  });

  it("missing linked drop 404", async () => {
    const bucket = new MemoryR2Bucket();
    const shortId = "Gone01";
    const fullId = "Gone01AbCdEf";
    bucket.seed(createRemoteAliasKey(shortId), fullId, "text/plain");

    const response = await callUnlock(
      bucket,
      shortId,
      fixture.requesterPublicJwk,
      fixture.providerPrivateJwkJson,
    );
    const responseText = await response.text();

    expect(response.status).toBe(404);
    expect(responseText).toContain("Drop not found");
    expect(responseText).not.toContain("wrappedKey");
    expectNoSensitiveResponseMaterial(responseText, fixture);
  });

  it("stored non-envelope 400", async () => {
    const bucket = new MemoryR2Bucket();
    const shortId = "Body01";
    const fullId = "Body01AbCdEf";
    bucket.seed(createRemoteAliasKey(shortId), fullId, "text/plain");
    bucket.seed(
      fullId,
      JSON.stringify({
        content: fixture.plaintext,
        accountId: fixture.accountId,
      }),
    );

    const response = await callUnlock(
      bucket,
      shortId,
      fixture.requesterPublicJwk,
      fixture.providerPrivateJwkJson,
    );
    const responseText = await response.text();

    expect(response.status).toBe(400);
    expect(responseText).toContain("not an encrypted envelope");
    expect(responseText).not.toContain("wrappedKey");
    expectNoSensitiveResponseMaterial(responseText, fixture);
  });
});

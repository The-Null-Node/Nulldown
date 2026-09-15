import { createHash, webcrypto } from "node:crypto";
import { jest } from "@jest/globals";
import type { R2Bucket } from "@cloudflare/workers-types";
import { onRequestPost } from "../functions/api/unlock/[id]";
import { createRemoteAliasKey } from "../functions/api/_lib/drops/identity/id";
import {
  DROP_ENVELOPE_SCHEMA_V1,
  DROP_ENVELOPE_VERSION_V1,
  type DropEnvelopeV1,
} from "../shared/drop/types";

interface StoredObject {
  value: string;
  contentType: string;
  etag: string;
  uploaded: Date;
}

class MemoryR2Bucket {
  private readonly objects = new Map<string, StoredObject>();

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

interface UnlockFixture {
  accountId: string;
  envelope: DropEnvelopeV1;
  plaintext: string;
  providerPrivateJwk: JsonWebKey;
  providerPrivateJwkJson: string;
  rawContentKey: ArrayBuffer;
  requesterPrivateKey: CryptoKey;
  requesterPublicJwk: JsonWebKey;
  vaultKeyId: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const toArrayBuffer = (value: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
};

const toBase64 = (value: ArrayBuffer | Uint8Array): string =>
  Buffer.from(value).toString("base64");

const fromBase64 = (value: string): Uint8Array =>
  new Uint8Array(Buffer.from(value, "base64"));

const generateRsaOaepKeyPair = async (): Promise<CryptoKeyPair> =>
  (await webcrypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKeyPair;

const createFixture = async (): Promise<UnlockFixture> => {
  const providerKeyPair = await generateRsaOaepKeyPair();
  const requesterKeyPair = await generateRsaOaepKeyPair();
  const providerPrivateJwk = await webcrypto.subtle.exportKey(
    "jwk",
    providerKeyPair.privateKey,
  );
  const requesterPublicJwk = await webcrypto.subtle.exportKey(
    "jwk",
    requesterKeyPair.publicKey,
  );
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
      schema: DROP_ENVELOPE_SCHEMA_V1,
      version: DROP_ENVELOPE_VERSION_V1,
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

const createRequest = (requesterPublicJwk: JsonWebKey): Request =>
  new Request("https://nulldown.test/api/unlock/drop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requesterPublicJwk }),
  });

const callUnlock = async (
  bucket: MemoryR2Bucket,
  id: string,
  requesterPublicJwk: JsonWebKey,
  providerPrivateJwk?: string,
): Promise<Response> =>
  onRequestPost({
    request: createRequest(requesterPublicJwk),
    env: {
      R2_BUCKET: bucket as unknown as R2Bucket,
      PROVIDER_ENCRYPTION_PRIVATE_JWK: providerPrivateJwk,
    },
    params: { id },
  } as unknown as Parameters<typeof onRequestPost>[0]);

const seedLinkedEnvelope = (
  bucket: MemoryR2Bucket,
  shortId: string,
  fullId: string,
  envelope: DropEnvelopeV1,
): void => {
  bucket.seed(createRemoteAliasKey(shortId), fullId, "text/plain");
  bucket.seed(fullId, JSON.stringify(envelope));
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
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
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

  it("vault-only rejects even with valid requester key", async () => {
    const bucket = new MemoryR2Bucket();
    const shortId = "Vault1";
    const fullId = "Vault1AbCdEf";
    const envelope: DropEnvelopeV1 = {
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
    const tamperedBytes = fromBase64(fixture.envelope.providerEscrow!.wrappedKey);
    tamperedBytes[0] ^= 0xff;
    const envelope: DropEnvelopeV1 = {
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
      JSON.stringify({ content: fixture.plaintext, accountId: fixture.accountId }),
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

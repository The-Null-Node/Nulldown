import { webcrypto } from "node:crypto";
import { jest } from "@jest/globals";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { onRequest, onRequestPost } from "../functions/api/auth/session";
import {
  ACCOUNT_RECORD_PREFIX,
  issueAccountSessionToken,
  resolveAuthenticatedAccountId,
  verifyAccountSessionToken,
} from "../functions/api/_lib/accounts/session/auth";
import { serializeCanonicalJson } from "../shared/drop/types";

const crypto = webcrypto;
const textEncoder = new TextEncoder();
const accountId = "acct-session-contract";
const accountRecordKey = `${ACCOUNT_RECORD_PREFIX}${accountId}.json`;
const accountSecret = "account-session-contract-secret";

const signAccountToken = async (payload: Record<string, unknown>): Promise<string> => {
  const encodedPayload = toBase64Url(textEncoder.encode(JSON.stringify(payload)));
  const signingInput = `ndacc.v1.${encodedPayload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(accountSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(signingInput));
  return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`;
};

interface StoredObject {
  value: string;
  contentType: string;
}

class MemoryR2Bucket {
  private readonly objects = new Map<string, StoredObject>();

  seed(key: string, value: string, contentType = "application/json"): void {
    this.objects.set(key, { value, contentType });
  }

  text(key: string): string | null {
    return this.objects.get(key)?.value ?? null;
  }

  async get(key: string): Promise<any> {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      key,
      body: new Response(stored.value).body,
      httpMetadata: { contentType: stored.contentType },
      text: async () => stored.value,
      json: async <T>() => JSON.parse(stored.value) as T,
    };
  }

  async head(key: string): Promise<any> {
    const stored = this.objects.get(key);
    return stored ? { key, httpMetadata: { contentType: stored.contentType } } : null;
  }

  async put(key: string, value: unknown, options?: any): Promise<any> {
    if (options?.onlyIf?.etagDoesNotMatch === "*" && this.objects.has(key)) {
      return null;
    }

    const text = typeof value === "string" ? value : await new Response(value as BodyInit).text();
    this.objects.set(key, {
      value: text,
      contentType: options?.httpMetadata?.contentType ?? "application/json",
    });
    return { key };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.objects.delete(key);
    }
  }

  async list(): Promise<any> {
    return { objects: [], truncated: false };
  }
}

interface AccountRow {
  account_id: string;
  signing_public_jwk: string;
  encryption_kid?: string | null;
  encryption_public_jwk?: string | null;
  created_at: number;
  updated_at: number;
}

class MemoryD1Statement {
  private params: unknown[] = [];

  constructor(
    private readonly database: MemoryD1Database,
    private readonly sql: string,
  ) {}

  bind(...params: unknown[]): this {
    this.params = params;
    return this;
  }

  async run(): Promise<{ success: true }> {
    this.database.run(this.sql, this.params);
    return { success: true };
  }

  async first<T>(): Promise<T | null> {
    return this.database.first(this.sql, this.params) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: [] };
  }
}

class MemoryD1Database {
  private readonly accounts = new Map<string, AccountRow>();

  prepare(sql: string): MemoryD1Statement {
    return new MemoryD1Statement(this, sql);
  }

  seedAccount(row: AccountRow): void {
    this.accounts.set(row.account_id, row);
  }

  account(account: string): AccountRow | null {
    return this.accounts.get(account) ?? null;
  }

  accountCount(): number {
    return this.accounts.size;
  }

  run(sql: string, params: unknown[]): void {
    if (sql.includes("UPDATE accounts")) {
      const account = String(params[3]);
      const existing = this.accounts.get(account);
      if (existing && !existing.encryption_kid && !existing.encryption_public_jwk) {
        this.accounts.set(account, {
          ...existing,
          encryption_kid: String(params[0]),
          encryption_public_jwk: String(params[1]),
          updated_at: Number(params[2]),
        });
      }
      return;
    }
    if (!sql.includes("INSERT INTO accounts")) return;

    const account = String(params[0]);
    const existing = this.accounts.get(account);
    if (existing && sql.includes("ON CONFLICT(account_id) DO NOTHING")) {
      return;
    }

    this.accounts.set(account, {
      account_id: account,
      signing_public_jwk: String(params[1]),
      encryption_kid: params[2] === null ? null : String(params[2]),
      encryption_public_jwk: params[3] === null ? null : String(params[3]),
      created_at: Number(params[4]),
      updated_at: Number(params[5]),
    });
  }

  first(sql: string, params: unknown[]): AccountRow | null {
    if (!sql.includes("FROM accounts")) return null;
    return this.accounts.get(String(params[0])) ?? null;
  }
}

interface AccountProof {
  publicJwk: JsonWebKey;
  keyPair: CryptoKeyPair;
  signedAt: number;
  signature: string;
}

interface EncryptionRecipient {
  encryptionKid: string;
  encryptionPublicJwk: JsonWebKey;
}

const toBase64Url = (input: Uint8Array): string => {
  let binary = "";
  input.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const createProof = async (
  proofAccountId = accountId,
  signedAt = Date.now(),
  recipient?: EncryptionRecipient,
  keyPair?: CryptoKeyPair,
): Promise<AccountProof> => {
  const pair = keyPair ?? (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const message = recipient
    ? `nulldown-account-auth\n${proofAccountId}\n${signedAt}\n${serializeCanonicalJson(recipient)}`
    : `nulldown-account-auth\n${proofAccountId}\n${signedAt}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    textEncoder.encode(message),
  );

  return {
    publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
    keyPair: pair,
    signedAt,
    signature: toBase64Url(new Uint8Array(signature)),
  };
};

const createRecipient = async (kid = "enc_recipient"): Promise<EncryptionRecipient> => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    encryptionKid: kid,
    encryptionPublicJwk: { kty: "RSA", n: publicJwk.n, e: publicJwk.e },
  };
};

const createRequest = (body: unknown): Request =>
  new Request("https://nulldown.test/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const createEnv = (bucket: MemoryR2Bucket, database?: MemoryD1Database) => ({
  R2_BUCKET: bucket as unknown as R2Bucket,
  ...(database ? { DB: database as unknown as D1Database } : {}),
  ACCOUNT_AUTH_SECRET: accountSecret,
});

const postSession = async (
  bucket: MemoryR2Bucket,
  database: MemoryD1Database | undefined,
  body: unknown,
): Promise<Response> =>
  onRequestPost({
    request: createRequest(body),
    env: createEnv(bucket, database),
  } as unknown as Parameters<typeof onRequestPost>[0]);

const requestBody = (
  proof: AccountProof,
  requestAccountId = accountId,
  recipient?: EncryptionRecipient,
) => ({
  accountId: requestAccountId,
  signingPublicJwk: proof.publicJwk,
  signedAt: proof.signedAt,
  signature: proof.signature,
  ...(recipient ? recipient : {}),
});

describe("functions account session API contracts", () => {
  it("pins the first real ECDSA proof in D1 and R2 and issues a verifiable ndacc.v1 token", async () => {
    const bucket = new MemoryR2Bucket();
    const database = new MemoryD1Database();
    const proof = await createProof();

    const response = await postSession(bucket, database, {
      ...requestBody(proof),
      credentialId: "AAAAAAAAAAAAAAAAAAAAAA",
    });
    const body = (await response.json()) as { accountId: string; token: string };
    const r2Record = JSON.parse(bucket.text(accountRecordKey) ?? "null");
    const d1Record = database.account(accountId);

    expect(response.status).toBe(200);
    expect(body.accountId).toBe(accountId);
    expect(body.token).toMatch(/^ndacc\.v1\./);
    const issuedPayload = await verifyAccountSessionToken(body.token, {
      ACCOUNT_AUTH_SECRET: accountSecret,
    });
    expect(issuedPayload).toMatchObject({ accountId });
    expect(issuedPayload?.credentialId).toBeUndefined();
    expect(r2Record).toEqual(
      expect.objectContaining({ accountId, signingPublicJwk: proof.publicJwk }),
    );
    expect(JSON.parse(d1Record?.signing_public_jwk ?? "null")).toEqual(proof.publicJwk);
  });

  it("keeps the first pinned key when a different proof claims the account", async () => {
    const bucket = new MemoryR2Bucket();
    const database = new MemoryD1Database();
    const first = await createProof();
    const competing = await createProof();

    expect((await postSession(bucket, database, requestBody(first))).status).toBe(200);
    const originalR2 = bucket.text(accountRecordKey);
    const originalD1 = database.account(accountId)?.signing_public_jwk;
    const response = await postSession(bucket, database, requestBody(competing));

    expect(response.status).toBe(401);
    expect(bucket.text(accountRecordKey)).toBe(originalR2);
    expect(database.account(accountId)?.signing_public_jwk).toBe(originalD1);
  });

  it("persists a signed canonical encryption recipient in D1 and R2", async () => {
    const bucket = new MemoryR2Bucket();
    const database = new MemoryD1Database();
    const recipient = await createRecipient();
    const proof = await createProof(accountId, Date.now(), recipient);

    const response = await postSession(bucket, database, requestBody(proof, accountId, recipient));
    const r2Record = JSON.parse(bucket.text(accountRecordKey) ?? "null");
    const d1Record = database.account(accountId);

    expect(response.status).toBe(200);
    expect(r2Record).toEqual(expect.objectContaining(recipient));
    expect(d1Record?.encryption_kid).toBe(recipient.encryptionKid);
    expect(JSON.parse(d1Record?.encryption_public_jwk ?? "null")).toEqual(
      recipient.encryptionPublicJwk,
    );
  });

  it("rejects tampered recipient material and preserves an existing pin", async () => {
    const bucket = new MemoryR2Bucket();
    const database = new MemoryD1Database();
    const recipient = await createRecipient();
    const proof = await createProof(accountId, Date.now(), recipient);
    await postSession(bucket, database, requestBody(proof, accountId, recipient));
    const original = bucket.text(accountRecordKey);

    const response = await postSession(bucket, database, requestBody(proof, accountId, {
      ...recipient,
      encryptionKid: "enc_tampered",
    }));

    expect(response.status).toBe(401);
    expect(bucket.text(accountRecordKey)).toBe(original);
  });

  it("does not let a different signing key update a pinned recipient", async () => {
    const bucket = new MemoryR2Bucket();
    const database = new MemoryD1Database();
    const recipient = await createRecipient();
    const proof = await createProof(accountId, Date.now(), recipient);
    await postSession(bucket, database, requestBody(proof, accountId, recipient));
    const original = bucket.text(accountRecordKey);
    const competingRecipient = await createRecipient("enc_competing");
    const competingProof = await createProof(accountId, Date.now(), competingRecipient);

    const response = await postSession(
      bucket,
      database,
      requestBody(competingProof, accountId, competingRecipient),
    );

    expect(response.status).toBe(401);
    expect(bucket.text(accountRecordKey)).toBe(original);
  });

  it("rejects private recipient JWK material before it reaches account storage", async () => {
    const bucket = new MemoryR2Bucket();
    const recipient = await createRecipient();
    const proof = await createProof();

    const response = await postSession(bucket, undefined, {
      ...requestBody(proof),
      encryptionKid: recipient.encryptionKid,
      encryptionPublicJwk: { ...recipient.encryptionPublicJwk, d: "secret" },
    });

    expect(response.status).toBe(400);
    expect(bucket.text(accountRecordKey)).toBeNull();
  });

  it("accepts the unchanged pin but rejects signed replacement attempts", async () => {
    const bucket = new MemoryR2Bucket();
    const database = new MemoryD1Database();
    const recipient = await createRecipient();
    const first = await createProof(accountId, Date.now(), recipient);
    const replacement = await createRecipient("enc_replacement");
    const replacementProof = await createProof(
      accountId,
      Date.now(),
      replacement,
      first.keyPair,
    );

    expect(
      (await postSession(bucket, database, requestBody(first, accountId, recipient))).status,
    ).toBe(200);
    expect(
      (await postSession(bucket, database, requestBody(first, accountId, recipient))).status,
    ).toBe(200);
    expect(
      (await postSession(
        bucket,
        database,
        requestBody(replacementProof, accountId, replacement),
      )).status,
    ).toBe(409);
    expect(JSON.parse(bucket.text(accountRecordKey) ?? "null")).toEqual(
      expect.objectContaining(recipient),
    );
  });

  it("reads pre-recipient D1 and R2 account records for legacy proofs", async () => {
    const bucket = new MemoryR2Bucket();
    const database = new MemoryD1Database();
    const proof = await createProof();
    const legacyRecord = {
      version: 1,
      accountId,
      signingPublicJwk: proof.publicJwk,
      createdAt: 1,
      updatedAt: 2,
    };
    bucket.seed(accountRecordKey, JSON.stringify(legacyRecord));
    database.seedAccount({
      account_id: accountId,
      signing_public_jwk: JSON.stringify(proof.publicJwk),
      created_at: 1,
      updated_at: 2,
    });

    const response = await postSession(bucket, database, requestBody(proof));

    expect(response.status).toBe(200);
    expect(JSON.parse(bucket.text(accountRecordKey) ?? "null")).not.toHaveProperty(
      "encryptionPublicJwk",
    );
    expect(database.account(accountId)?.encryption_public_jwk).toBeNull();
  });

  it("allows only one concurrent first proof to reserve an account", async () => {
    const bucket = new MemoryR2Bucket();
    const database = new MemoryD1Database();
    const first = await createProof();
    const competing = await createProof();

    const responses = await Promise.all([
      postSession(bucket, database, requestBody(first)),
      postSession(bucket, database, requestBody(competing)),
    ]);
    const winner = responses.find((response) => response.status === 200);
    const storedJwk = JSON.parse(database.account(accountId)?.signing_public_jwk ?? "null");

    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
    expect(database.accountCount()).toBe(1);
    expect([first.publicJwk, competing.publicJwk]).toContainEqual(storedJwk);
    expect(JSON.parse(bucket.text(accountRecordKey) ?? "null").signingPublicJwk).toEqual(
      storedJwk,
    );
    expect(winner).toBeDefined();
  });

  it.each([
    ["stale proof", async () => {
      const proof = await createProof(accountId, Date.now() - 5 * 60 * 1000 - 1);
      return requestBody(proof);
    }],
    ["malformed signature", async () => {
      const proof = await createProof();
      return { ...requestBody(proof), signature: "%%%" };
    }],
    ["malformed P-256 JWK", async () => ({
      accountId,
      signingPublicJwk: { kty: "EC", crv: "P-256", x: "bad", y: "bad" },
      signedAt: Date.now(),
      signature: "invalid",
    })],
  ])("rejects %s without creating either account record", async (_name, createBody) => {
    const bucket = new MemoryR2Bucket();
    const database = new MemoryD1Database();
    const response = await postSession(bucket, database, await createBody());

    expect(response.status).toBe(401);
    expect(bucket.text(accountRecordKey)).toBeNull();
    expect(database.accountCount()).toBe(0);
  });

  it.each(["missing", "malformed"] as const)(
    "falls back to R2 and repairs a %s D1 account record without accepting a new key",
    async (d1State) => {
      const bucket = new MemoryR2Bucket();
      const database = new MemoryD1Database();
      const original = await createProof();
      const competing = await createProof();
      const record = {
        version: 1,
        accountId,
        signingPublicJwk: original.publicJwk,
        createdAt: 1,
        updatedAt: 2,
      };
      bucket.seed(accountRecordKey, JSON.stringify(record));
      if (d1State === "malformed") {
        database.seedAccount({
          account_id: accountId,
          signing_public_jwk: "{not JSON",
          created_at: 1,
          updated_at: 2,
        });
      }

      const response = await postSession(bucket, database, requestBody(competing));

      expect(response.status).toBe(401);
      expect(JSON.parse(database.account(accountId)?.signing_public_jwk ?? "null")).toEqual(
        original.publicJwk,
      );
      expect(JSON.parse(bucket.text(accountRecordKey) ?? "null")).toEqual(record);
    },
  );

  it("returns stable route validation and binding errors", async () => {
    const bucket = new MemoryR2Bucket();

    const missingBucket = await onRequestPost({
      request: createRequest({}),
      env: { ACCOUNT_AUTH_SECRET: accountSecret },
    } as unknown as Parameters<typeof onRequestPost>[0]);
    const missingSecret = await onRequestPost({
      request: createRequest({}),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
    } as unknown as Parameters<typeof onRequestPost>[0]);
    const invalidAccountId = await postSession(bucket, undefined, { accountId: "not valid/" });
    const missingProof = await postSession(bucket, undefined, { accountId });
    const methodNotAllowed = await onRequest({
      request: new Request("https://nulldown.test/api/auth/session", { method: "GET" }),
      env: createEnv(bucket),
    } as unknown as Parameters<typeof onRequest>[0]);

    expect(missingBucket.status).toBe(500);
    await expect(missingBucket.text()).resolves.toBe("R2 bucket binding is required.");
    expect(missingSecret.status).toBe(503);
    await expect(missingSecret.text()).resolves.toBe("ACCOUNT_AUTH_SECRET is required.");
    expect(invalidAccountId.status).toBe(400);
    await expect(invalidAccountId.text()).resolves.toBe("Valid accountId is required.");
    expect(missingProof.status).toBe(400);
    await expect(missingProof.text()).resolves.toBe(
      "signingPublicJwk, signedAt, and signature are required.",
    );
    expect(methodNotAllowed.status).toBe(405);
    await expect(methodNotAllowed.text()).resolves.toBe("Method Not Allowed");
  });

  it("returns invalid JSON body errors without a binding", async () => {
    const bucket = new MemoryR2Bucket();
    const response = await onRequestPost({
      request: new Request("https://nulldown.test/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
      env: createEnv(bucket),
    } as unknown as Parameters<typeof onRequestPost>[0]);

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("Invalid JSON body.");
  });

  it("fails closed for expired, tampered, wrong-secret, and malformed account tokens", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(10_000);
    const { token: expiredToken } = await issueAccountSessionToken(accountId, {
      ACCOUNT_AUTH_SECRET: accountSecret,
      ACCOUNT_AUTH_TOKEN_TTL_MS: "1",
    });
    const { token } = await issueAccountSessionToken(accountId, {
      ACCOUNT_AUTH_SECRET: accountSecret,
    });
    now.mockReturnValue(10_001);

    await expect(
      verifyAccountSessionToken(expiredToken, {
        ACCOUNT_AUTH_SECRET: accountSecret,
      }),
    ).resolves.toBeNull();
    await expect(
      verifyAccountSessionToken(`${token}x`, { ACCOUNT_AUTH_SECRET: accountSecret }),
    ).resolves.toBeNull();
    await expect(
      verifyAccountSessionToken(token, { ACCOUNT_AUTH_SECRET: "wrong-secret" }),
    ).resolves.toBeNull();
    await expect(
      verifyAccountSessionToken(`${token.slice(0, token.lastIndexOf(".") + 1)}%%%`, {
        ACCOUNT_AUTH_SECRET: accountSecret,
      }),
    ).resolves.toBeNull();
    now.mockRestore();
  });

  it("retains only server-issued CLI credential claims and rejects malformed signed claims", async () => {
    const credentialId = "AAAAAAAAAAAAAAAAAAAAAA";
    const cli = await issueAccountSessionToken(
      accountId,
      { ACCOUNT_AUTH_SECRET: accountSecret },
      { credentialId },
    );
    const browser = await issueAccountSessionToken(accountId, {
      ACCOUNT_AUTH_SECRET: accountSecret,
    });
    const malformed = await signAccountToken({
      version: 1,
      accountId,
      credentialId: 1,
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });

    await expect(
      verifyAccountSessionToken(cli.token, { ACCOUNT_AUTH_SECRET: accountSecret }),
    ).resolves.toEqual(expect.objectContaining({ accountId, credentialId }));
    const browserPayload = await verifyAccountSessionToken(browser.token, {
      ACCOUNT_AUTH_SECRET: accountSecret,
    });
    expect(browserPayload).toMatchObject({ accountId });
    expect(browserPayload?.credentialId).toBeUndefined();
    await expect(
      verifyAccountSessionToken(malformed, { ACCOUNT_AUTH_SECRET: accountSecret }),
    ).resolves.toBeNull();
    await expect(
      issueAccountSessionToken(
        accountId,
        { ACCOUNT_AUTH_SECRET: accountSecret },
        { credentialId: "caller-chosen" },
      ),
    ).rejects.toThrow("credential id is invalid");
  });

  it("rejects insecure account headers when a secret is configured unless the explicit escape is enabled", async () => {
    const request = new Request("https://nulldown.test/api/diff", {
      headers: { "x-nulldown-account-id": accountId },
    });

    await expect(
      resolveAuthenticatedAccountId(request, { ACCOUNT_AUTH_SECRET: accountSecret }),
    ).resolves.toBeNull();
    await expect(
      resolveAuthenticatedAccountId(request, {
        ACCOUNT_AUTH_SECRET: accountSecret,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      }),
    ).resolves.toBe(accountId);
  });
});

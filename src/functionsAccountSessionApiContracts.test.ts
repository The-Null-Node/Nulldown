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

const crypto = webcrypto;
const textEncoder = new TextEncoder();
const accountId = "acct-session-contract";
const accountRecordKey = `${ACCOUNT_RECORD_PREFIX}${accountId}.json`;
const accountSecret = "account-session-contract-secret";

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
    if (!sql.includes("INSERT INTO accounts")) return;

    const account = String(params[0]);
    const existing = this.accounts.get(account);
    if (existing && sql.includes("ON CONFLICT(account_id) DO NOTHING")) {
      return;
    }

    this.accounts.set(account, {
      account_id: account,
      signing_public_jwk: String(params[1]),
      created_at: Number(params[2]),
      updated_at: Number(params[3]),
    });
  }

  first(sql: string, params: unknown[]): AccountRow | null {
    if (!sql.includes("FROM accounts")) return null;
    return this.accounts.get(String(params[0])) ?? null;
  }
}

interface AccountProof {
  publicJwk: JsonWebKey;
  signedAt: number;
  signature: string;
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
): Promise<AccountProof> => {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const message = `nulldown-account-auth\n${proofAccountId}\n${signedAt}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    textEncoder.encode(message),
  );

  return {
    publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
    signedAt,
    signature: toBase64Url(new Uint8Array(signature)),
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

const requestBody = (proof: AccountProof, requestAccountId = accountId) => ({
  accountId: requestAccountId,
  signingPublicJwk: proof.publicJwk,
  signedAt: proof.signedAt,
  signature: proof.signature,
});

describe("functions account session API contracts", () => {
  it("pins the first real ECDSA proof in D1 and R2 and issues a verifiable ndacc.v1 token", async () => {
    const bucket = new MemoryR2Bucket();
    const database = new MemoryD1Database();
    const proof = await createProof();

    const response = await postSession(bucket, database, requestBody(proof));
    const body = (await response.json()) as { accountId: string; token: string };
    const r2Record = JSON.parse(bucket.text(accountRecordKey) ?? "null");
    const d1Record = database.account(accountId);

    expect(response.status).toBe(200);
    expect(body.accountId).toBe(accountId);
    expect(body.token).toMatch(/^ndacc\.v1\./);
    await expect(
      verifyAccountSessionToken(body.token, { ACCOUNT_AUTH_SECRET: accountSecret }),
    ).resolves.toMatchObject({ accountId });
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

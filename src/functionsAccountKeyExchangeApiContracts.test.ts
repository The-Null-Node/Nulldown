import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { D1Database } from "@cloudflare/workers-types";

import { onRequestPost as challengeRoute } from "../functions/api/account/challenge";
import { onRequestPost as bindRoute } from "../functions/api/account/bind";
import {
  onRequestGet as recoveryGetRoute,
  onRequestPut as recoveryPutRoute,
} from "../functions/api/account/recovery";
import type { AccountBindingEnvironment } from "../functions/api/_lib/accounts/binding/service";
import { issueAccountSessionToken } from "../functions/api/_lib/accounts/session/auth";
import type { VoidBlobObject, VoidBlobStore } from "./server/ports";
import {
  ACCOUNT_RECOVERY_PAYLOAD_SCHEMA_V1,
  serializeAccountRecoveryPackage,
  type EncryptedAccountRecoveryPackageV1,
  type AccountRecoveryPayloadV1,
} from "../shared/auth/recovery";
import { serializeAccountBindingChallenge } from "../shared/auth/accountBinding";
import { encryptAccountRecoveryPayload } from "./lib/void/vault/recovery/crypto";

const origin = "https://app.test";
const issuer = "https://issuer.test";
const clientId = "nulldown-browser-v1";
const accountSecret = "account-secret-for-tests";
const accessCookieName = "__Host-nulldown-open-auth-access";

interface BindingRow {
  account_id: string;
  user_id: string;
  signing_key_fingerprint: string;
  created_at: number;
  updated_at: number;
}

interface ChallengeRow {
  challenge_id: string;
  nonce_hash: string;
  user_id: string;
  account_id: string;
  origin: string;
  signing_key_fingerprint: string;
  issued_at: number;
  expires_at: number;
  consumed_at: number | null;
}

interface RecoveryRow {
  account_id: string;
  user_id: string;
  revision: number;
  object_key: string;
  ciphertext_digest: string;
  ciphertext_length: number;
  metadata_json: string;
  created_at: number;
  updated_at: number;
}

class MemoryStatement {
  private params: unknown[] = [];

  constructor(
    private readonly db: MemoryDatabase,
    private readonly sql: string,
  ) {}

  bind(...params: unknown[]): this {
    this.params = params;
    return this;
  }

  async run(): Promise<{ success: true }> {
    this.db.run(this.sql, this.params);
    return { success: true };
  }

  async first<T>(): Promise<T | null> {
    return this.db.first(this.sql, this.params) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: [] };
  }
}

class MemoryDatabase {
  readonly users = new Set<string>();
  readonly accounts = new Map<string, { signing_public_jwk: string; created_at: number; updated_at: number }>();
  readonly bindings = new Map<string, BindingRow>();
  readonly challenges = new Map<string, ChallengeRow>();
  readonly packages = new Map<string, RecoveryRow>();

  prepare(sql: string): MemoryStatement {
    return new MemoryStatement(this, sql);
  }

  run(sql: string, params: unknown[]): void {
    if (sql.includes("INSERT INTO auth_account_binding_challenges")) {
      this.challenges.set(String(params[0]), {
        challenge_id: String(params[0]),
        nonce_hash: String(params[1]),
        user_id: String(params[2]),
        account_id: String(params[3]),
        origin: String(params[4]),
        signing_key_fingerprint: String(params[5]),
        issued_at: Number(params[6]),
        expires_at: Number(params[7]),
        consumed_at: null,
      });
      return;
    }
    if (sql.includes("INSERT INTO auth_account_bindings")) {
      const accountId = String(params[0]);
      if (!this.bindings.has(accountId)) {
        this.bindings.set(accountId, {
          account_id: accountId,
          user_id: String(params[1]),
          signing_key_fingerprint: String(params[2]),
          created_at: Number(params[3]),
          updated_at: Number(params[4]),
        });
      }
      return;
    }
    if (sql.includes("INSERT INTO auth_account_recovery_packages")) {
      const accountId = String(params[0]);
      if (!this.packages.has(accountId)) {
        this.packages.set(accountId, {
          account_id: accountId,
          user_id: String(params[1]),
          revision: Number(params[2]),
          object_key: String(params[3]),
          ciphertext_digest: String(params[4]),
          ciphertext_length: Number(params[5]),
          metadata_json: String(params[6]),
          created_at: Number(params[7]),
          updated_at: Number(params[8]),
        });
      }
      return;
    }
    if (sql.includes("UPDATE auth_account_recovery_packages")) {
      const accountId = String(params[6]);
      const current = this.packages.get(accountId);
      if (current && current.user_id === String(params[7]) && current.revision === Number(params[8])) {
        this.packages.set(accountId, {
          ...current,
          revision: Number(params[0]),
          object_key: String(params[1]),
          ciphertext_digest: String(params[2]),
          ciphertext_length: Number(params[3]),
          metadata_json: String(params[4]),
          updated_at: Number(params[5]),
        });
      }
    }
  }

  first(sql: string, params: unknown[]): unknown {
    if (sql.includes("FROM auth_users")) {
      const userId = String(params[0]);
      return this.users.has(userId) ? { user_id: userId } : null;
    }
    if (sql.includes("FROM accounts")) {
      const accountId = String(params[0]);
      const row = this.accounts.get(accountId);
      return row ? { account_id: accountId, ...row } : null;
    }
    if (sql.includes("FROM auth_account_bindings")) {
      return this.bindings.get(String(params[0])) ?? null;
    }
    if (sql.startsWith("\n      UPDATE auth_account_binding_challenges") || sql.includes("UPDATE auth_account_binding_challenges")) {
      const row = this.challenges.get(String(params[1]));
      if (!row || row.consumed_at !== null || row.expires_at <= Number(params[2])) return null;
      row.consumed_at = Number(params[0]);
      return { challenge_id: row.challenge_id };
    }
    if (sql.includes("FROM auth_account_binding_challenges")) {
      return this.challenges.get(String(params[0])) ?? null;
    }
    if (sql.includes("FROM auth_account_recovery_packages")) {
      if (sql.includes("WHERE user_id")) {
        return [...this.packages.values()]
          .filter((row) => row.user_id === String(params[0]))
          .sort((a, b) => b.updated_at - a.updated_at)[0] ?? null;
      }
      return this.packages.get(String(params[0])) ?? null;
    }
    return null;
  }
}

class MemoryBlobObject implements VoidBlobObject {
  readonly body = null;

  constructor(
    readonly key: string,
    private readonly value: string,
  ) {}

  async text(): Promise<string> {
    return this.value;
  }

  async json<T>(): Promise<T> {
    return JSON.parse(this.value) as T;
  }
}

class MemoryBucket implements VoidBlobStore {
  readonly objects = new Map<string, string>();

  async get(key: string): Promise<VoidBlobObject | null> {
    const value = this.objects.get(key);
    return value === undefined ? null : new MemoryBlobObject(key, value);
  }

  async head(key: string) {
    return this.objects.has(key) ? { key } : null;
  }

  async put(key: string, value: unknown): Promise<{ key: string } | null> {
    this.objects.set(key, String(value));
    return { key };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  async list() {
    return { objects: [...this.objects.keys()].map((key) => ({ key })), truncated: false };
  }
}

class FakeAuthority {
  private readonly tokens = new Map<string, string>();

  private constructor(
    private readonly privateKey: CryptoKey,
    private readonly jwk: JsonWebKey,
  ) {}

  static async create(): Promise<FakeAuthority> {
    const pair = await generateKeyPair("ES256");
    const jwk = await exportJWK(pair.publicKey);
    jwk.kid = "test-key";
    jwk.alg = "ES256";
    return new FakeAuthority(pair.privateKey as CryptoKey, jwk);
  }

  async token(userId: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      mode: "access",
      type: "nulldown-user",
      properties: { version: 1, userId },
    })
      .setProtectedHeader({ alg: "ES256", kid: "test-key", typ: "JWT" })
      .setIssuer(issuer)
      .setAudience(clientId)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(this.privateKey);
    this.tokens.set(userId, token);
    return token;
  }

  async fetch(input: RequestInfo | URL): Promise<Response> {
    const url = new URL(input.toString());
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({ jwks_uri: `${issuer}/.well-known/jwks.json` });
    }
    if (url.pathname === "/.well-known/jwks.json") {
      return Response.json({ keys: [this.jwk] });
    }
    return new Response("Not Found", { status: 404 });
  }
}

const toBase64Url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64url");

const requestContext = (request: Request, env: AccountBindingEnvironment) =>
  ({ request, env }) as never;

const createHarness = async (userId = "user_01") => {
  const database = new MemoryDatabase();
  database.users.add(userId);
  const bucket = new MemoryBucket();
  const authority = await FakeAuthority.create();
  const access = await authority.token(userId);
  const signingPair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const accountId = "account-01";
  const signingPublicJwk = await crypto.subtle.exportKey("jwk", signingPair.publicKey);
  database.accounts.set(accountId, {
    signing_public_jwk: JSON.stringify(signingPublicJwk),
    created_at: 1_000,
    updated_at: 1_000,
  });
  const { token: accountToken } = await issueAccountSessionToken(accountId, {
    ACCOUNT_AUTH_SECRET: accountSecret,
  });
  const env: AccountBindingEnvironment = {
    DB: database as unknown as D1Database,
    R2_BUCKET: bucket,
    ACCOUNT_AUTH_SECRET: accountSecret,
    OPENAUTH_ISSUER_URL: issuer,
    OPENAUTH_CLIENT_ID: clientId,
    OPENAUTH_AUDIENCE: clientId,
    OPENAUTH_BFF_ORIGIN: origin,
    OPENAUTH_AUTHORITY: authority,
  };
  const headers = {
    Origin: origin,
    Cookie: `${accessCookieName}=${access}`,
    Authorization: `Bearer ${accountToken}`,
  };
  return { database, bucket, authority, env, headers, accountId, signingPair, signingPublicJwk };
};

const bindHarnessAccount = async (harness: Awaited<ReturnType<typeof createHarness>>) => {
  const challengeResponse = await challengeRoute(
    requestContext(
      new Request(`${origin}/api/account/challenge`, { method: "POST", headers: harness.headers }),
      harness.env,
    ),
  );
  const challengeBody = (await challengeResponse.json()) as { challenge: Parameters<typeof serializeAccountBindingChallenge>[0] };
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    harness.signingPair.privateKey,
    new TextEncoder().encode(serializeAccountBindingChallenge(challengeBody.challenge)),
  );
  const bindResponse = await bindRoute(
    requestContext(
      new Request(`${origin}/api/account/bind`, {
        method: "POST",
        headers: { ...harness.headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          challenge: challengeBody.challenge,
          signature: toBase64Url(new Uint8Array(signature)),
        }),
      }),
      harness.env,
    ),
  );
  return { challengeBody, bindResponse };
};

const createRecoveryPayload = async (
  harness: Awaited<ReturnType<typeof createHarness>>,
): Promise<AccountRecoveryPayloadV1> => {
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
  return {
    schema: ACCOUNT_RECOVERY_PAYLOAD_SCHEMA_V1,
    version: 1,
    accountId: harness.accountId,
    encryptionKid: "enc_01",
    signingKid: "sig_01",
    encryptionPublicJwk: await crypto.subtle.exportKey("jwk", encryptionPair.publicKey),
    encryptionPrivateJwk: await crypto.subtle.exportKey("jwk", encryptionPair.privateKey),
    signingPublicJwk: harness.signingPublicJwk,
    signingPrivateJwk: await crypto.subtle.exportKey("jwk", harness.signingPair.privateKey),
    createdAt: 1_000,
  };
};

const signedRecoveryUpload = async (
  harness: Awaited<ReturnType<typeof createHarness>>,
  encryptedPackage: EncryptedAccountRecoveryPackageV1,
  privateKey = harness.signingPair.privateKey,
) => {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(serializeAccountRecoveryPackage(encryptedPackage)),
  );
  return {
    package: encryptedPackage,
    signature: toBase64Url(new Uint8Array(signature)),
  };
};

describe("account key-exchange Pages contracts", () => {
  it("rejects cross-origin challenge creation before persisting anything", async () => {
    const harness = await createHarness();
    const response = await challengeRoute(
      requestContext(
        new Request(`${origin}/api/account/challenge`, {
          method: "POST",
          headers: { ...harness.headers, Origin: "https://evil.test" },
        }),
        harness.env,
      ),
    );
    expect(response.status).toBe(403);
    expect(harness.database.challenges.size).toBe(0);
  });

  it("binds only a valid pinned-key challenge and does not mutate on replay", async () => {
    const harness = await createHarness();
    const { challengeBody, bindResponse } = await bindHarnessAccount(harness);
    expect(bindResponse.status).toBe(201);
    expect(harness.database.bindings.get(harness.accountId)?.user_id).toBe("user_01");

    const replaySignature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      harness.signingPair.privateKey,
      new TextEncoder().encode(serializeAccountBindingChallenge(challengeBody.challenge)),
    );
    const replay = await bindRoute(
      requestContext(
        new Request(`${origin}/api/account/bind`, {
          method: "POST",
          headers: { ...harness.headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            challenge: challengeBody.challenge,
            signature: toBase64Url(new Uint8Array(replaySignature)),
          }),
        }),
        harness.env,
      ),
    );
    expect(replay.status).toBe(200);
    expect(harness.database.bindings.size).toBe(1);
  });

  it("rejects a wrong signing key without consuming or binding the challenge", async () => {
    const harness = await createHarness();
    const challengeResponse = await challengeRoute(
      requestContext(
        new Request(`${origin}/api/account/challenge`, { method: "POST", headers: harness.headers }),
        harness.env,
      ),
    );
    const challengeBody = (await challengeResponse.json()) as { challenge: Parameters<typeof serializeAccountBindingChallenge>[0] };
    const other = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      other.privateKey,
      new TextEncoder().encode(serializeAccountBindingChallenge(challengeBody.challenge)),
    );
    const response = await bindRoute(
      requestContext(
        new Request(`${origin}/api/account/bind`, {
          method: "POST",
          headers: { ...harness.headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            challenge: challengeBody.challenge,
            signature: toBase64Url(new Uint8Array(signature)),
          }),
        }),
        harness.env,
      ),
    );
    expect(response.status).toBe(401);
    expect(harness.database.bindings.size).toBe(0);
    expect(harness.database.challenges.get(challengeBody.challenge.challengeId)?.consumed_at).toBeNull();
  });

  it("rejects an expired challenge without creating a binding", async () => {
    const harness = await createHarness();
    const challengeResponse = await challengeRoute(
      requestContext(
        new Request(`${origin}/api/account/challenge`, { method: "POST", headers: harness.headers }),
        harness.env,
      ),
    );
    const challenge = ((await challengeResponse.json()) as { challenge: Parameters<typeof serializeAccountBindingChallenge>[0] }).challenge;
    const stored = harness.database.challenges.get(challenge.challengeId);
    if (!stored) throw new Error("Expected persisted challenge.");
    stored.expires_at = Date.now() - 1;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      harness.signingPair.privateKey,
      new TextEncoder().encode(serializeAccountBindingChallenge(challenge)),
    );
    const response = await bindRoute(
      requestContext(
        new Request(`${origin}/api/account/bind`, {
          method: "POST",
          headers: { ...harness.headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            challenge,
            signature: toBase64Url(new Uint8Array(signature)),
          }),
        }),
        harness.env,
      ),
    );
    expect(response.status).toBe(409);
    expect(harness.database.bindings.size).toBe(0);
  });

  it("allows only one OpenAuth user to win competing valid account claims", async () => {
    const harness = await createHarness();
    harness.database.users.add("user_02");
    const secondAccess = await harness.authority.token("user_02");
    const secondHeaders = {
      ...harness.headers,
      Cookie: `${accessCookieName}=${secondAccess}`,
    };
    const [firstChallengeResponse, secondChallengeResponse] = await Promise.all([
      challengeRoute(
        requestContext(
          new Request(`${origin}/api/account/challenge`, {
            method: "POST",
            headers: harness.headers,
          }),
          harness.env,
        ),
      ),
      challengeRoute(
        requestContext(
          new Request(`${origin}/api/account/challenge`, {
            method: "POST",
            headers: secondHeaders,
          }),
          harness.env,
        ),
      ),
    ]);
    const firstChallenge = ((await firstChallengeResponse.json()) as { challenge: Parameters<typeof serializeAccountBindingChallenge>[0] }).challenge;
    const secondChallenge = ((await secondChallengeResponse.json()) as { challenge: Parameters<typeof serializeAccountBindingChallenge>[0] }).challenge;
    const sign = async (challenge: typeof firstChallenge) =>
      toBase64Url(
        new Uint8Array(
          await crypto.subtle.sign(
            { name: "ECDSA", hash: "SHA-256" },
            harness.signingPair.privateKey,
            new TextEncoder().encode(serializeAccountBindingChallenge(challenge)),
          ),
        ),
      );
    const [first, second] = await Promise.all([
      bindRoute(
        requestContext(
          new Request(`${origin}/api/account/bind`, {
            method: "POST",
            headers: { ...harness.headers, "Content-Type": "application/json" },
            body: JSON.stringify({ challenge: firstChallenge, signature: await sign(firstChallenge) }),
          }),
          harness.env,
        ),
      ),
      bindRoute(
        requestContext(
          new Request(`${origin}/api/account/bind`, {
            method: "POST",
            headers: { ...secondHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ challenge: secondChallenge, signature: await sign(secondChallenge) }),
          }),
          harness.env,
        ),
      ),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    expect(harness.database.bindings.size).toBe(1);
  });

  it("stores only ciphertext and lets only the owning OpenAuth user retrieve it", async () => {
    const harness = await createHarness();
    expect((await bindHarnessAccount(harness)).bindResponse.status).toBe(201);
    const encrypted = await encryptAccountRecoveryPayload({
      payload: await createRecoveryPayload(harness),
      userId: "user_01",
      revision: 1,
    });
    const put = await recoveryPutRoute(
      requestContext(
        new Request(`${origin}/api/account/recovery`, {
          method: "PUT",
          headers: { ...harness.headers, "Content-Type": "application/json" },
          body: JSON.stringify(await signedRecoveryUpload(harness, encrypted.package)),
        }),
        harness.env,
      ),
    );
    expect(put.status).toBe(201);
    const storedBody = [...harness.bucket.objects.values()].join("\n");
    expect(storedBody).not.toContain("signingPrivateJwk");
    expect(storedBody).not.toContain("encryptionPrivateJwk");

    const get = await recoveryGetRoute(
      requestContext(
        new Request(`${origin}/api/account/recovery`, {
          headers: { Cookie: harness.headers.Cookie },
        }),
        harness.env,
      ),
    );
    expect(get.status).toBe(200);
    await expect(get.json()).resolves.toEqual({ available: true, package: encrypted.package });

    harness.database.users.add("user_02");
    const otherAccess = await harness.authority.token("user_02");
    const denied = await recoveryGetRoute(
      requestContext(
        new Request(`${origin}/api/account/recovery`, {
          headers: { Cookie: `${accessCookieName}=${otherAccess}` },
        }),
        harness.env,
      ),
    );
    expect(denied.status).toBe(404);

    const tamperedCiphertext = `${
      encrypted.package.ciphertext.startsWith("A") ? "B" : "A"
    }${encrypted.package.ciphertext.slice(1)}`;
    const tampered = await recoveryPutRoute(
      requestContext(
        new Request(`${origin}/api/account/recovery`, {
          method: "PUT",
          headers: { ...harness.headers, "Content-Type": "application/json" },
          body: JSON.stringify(await signedRecoveryUpload(harness, {
            ...encrypted.package,
            ciphertext: tamperedCiphertext,
          })),
        }),
        harness.env,
      ),
    );
    expect(tampered.status).toBe(400);

    const stalePackage = await encryptAccountRecoveryPayload({
      payload: await createRecoveryPayload(harness),
      userId: "user_01",
      revision: 1,
    });
    const stale = await recoveryPutRoute(
      requestContext(
        new Request(`${origin}/api/account/recovery`, {
          method: "PUT",
          headers: { ...harness.headers, "Content-Type": "application/json" },
          body: JSON.stringify(await signedRecoveryUpload(harness, stalePackage.package)),
        }),
        harness.env,
      ),
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({
      error: "recovery_revision_conflict",
      currentRevision: 1,
    });

    const rotatedPackage = await encryptAccountRecoveryPayload({
      payload: await createRecoveryPayload(harness),
      userId: "user_01",
      revision: 2,
    });
    const attacker = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const forgedRotation = await recoveryPutRoute(
      requestContext(
        new Request(`${origin}/api/account/recovery`, {
          method: "PUT",
          headers: { ...harness.headers, "Content-Type": "application/json" },
          body: JSON.stringify(
            await signedRecoveryUpload(
              harness,
              rotatedPackage.package,
              attacker.privateKey,
            ),
          ),
        }),
        harness.env,
      ),
    );
    expect(forgedRotation.status).toBe(401);
    expect(harness.database.packages.get(harness.accountId)?.revision).toBe(1);

    const rotated = await recoveryPutRoute(
      requestContext(
        new Request(`${origin}/api/account/recovery`, {
          method: "PUT",
          headers: { ...harness.headers, "Content-Type": "application/json" },
          body: JSON.stringify(await signedRecoveryUpload(harness, rotatedPackage.package)),
        }),
        harness.env,
      ),
    );
    expect(rotated.status).toBe(201);
    expect(harness.database.packages.get(harness.accountId)?.revision).toBe(2);
  });
});

import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import type { D1Database } from "@cloudflare/workers-types";

import { onRequest as callbackRoute, onRequestGet as callback } from "../functions/api/auth/open/callback";
import { onRequestGet as login } from "../functions/api/auth/open/login";
import { onRequest as logoutRoute, onRequestPost as logout } from "../functions/api/auth/open/logout";
import { onRequestGet as principal } from "../functions/api/auth/open/principal";
import type { OpenAuthBffEnvironment } from "../functions/api/_lib/accounts/openAuth/service";

const appOrigin = "https://app.test";
const issuer = "https://issuer.test";
const clientId = "nulldown-browser-v1";
const transactionCookieName = "__Host-nulldown-open-auth-transaction";
const accessCookieName = "__Host-nulldown-open-auth-access";
const refreshCookieName = "__Host-nulldown-open-auth-refresh";

interface CallbackTransactionRow {
  return_to: string;
  expires_at: number;
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
}

class MemoryD1Database {
  readonly sqlLog: string[] = [];
  readonly users = new Set<string>();
  readonly identities = new Map<string, string>();
  readonly transactions = new Map<string, CallbackTransactionRow>();
  legacyWriteCount = 0;

  prepare(sql: string): MemoryD1Statement {
    return new MemoryD1Statement(this, sql);
  }

  run(sql: string, params: unknown[]): void {
    this.sqlLog.push(sql);
    if (/\b(?:accounts|branches|drops)\b/i.test(sql) && !sql.includes("auth_")) {
      this.legacyWriteCount += 1;
    }
    if (sql.includes("INSERT INTO auth_callback_transactions")) {
      this.transactions.set(String(params[0]), {
        return_to: String(params[1]),
        expires_at: Number(params[3]),
      });
      return;
    }
    if (sql.includes("INSERT INTO auth_users")) {
      this.users.add(String(params[0]));
      return;
    }
    if (sql.includes("INSERT INTO auth_external_identities")) {
      const key = [params[0], params[1], params[2]].map(String).join("\u0000");
      if (!this.identities.has(key)) this.identities.set(key, String(params[3]));
    }
  }

  first(sql: string, params: unknown[]): unknown {
    if (sql.includes("DELETE FROM auth_callback_transactions")) {
      const stateHash = String(params[0]);
      const transaction = this.transactions.get(stateHash);
      if (!transaction || transaction.expires_at <= Number(params[1])) return null;
      this.transactions.delete(stateHash);
      return { return_to: transaction.return_to };
    }
    if (sql.includes("FROM auth_external_identities")) {
      const key = [params[0], params[1], params[2]].map(String).join("\u0000");
      const userId = this.identities.get(key);
      return userId ? { user_id: userId } : null;
    }
    return null;
  }
}

class MemoryR2Bucket {
  writeCount = 0;

  async put(): Promise<null> {
    this.writeCount += 1;
    return null;
  }
}

class FakeOpenAuthFetcher {
  readonly requests: Array<{ url: string; authorization: string | null }> = [];
  readonly exchanges: Array<{ code: string; redirectUri: string; verifier: string }> = [];
  private readonly codes = new Map<string, { access: string; refresh: string; expiresIn: number }>();

  private constructor(
    private readonly privateKey: KeyLike | CryptoKey,
    private readonly jwk: JsonWebKey,
  ) {}

  static async create(): Promise<FakeOpenAuthFetcher> {
    const pair = await generateKeyPair("ES256");
    const jwk = await exportJWK(pair.publicKey);
    jwk.kid = "test-key";
    jwk.alg = "ES256";
    return new FakeOpenAuthFetcher(pair.privateKey, jwk);
  }

  async issueAccessToken(
    userId = "user_01",
    options: Readonly<{
      issuer?: string;
      audience?: string;
      expiresAt?: number;
      type?: string;
      properties?: unknown;
    }> = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      mode: "access",
      type: options.type ?? "nulldown-user",
      properties: options.properties ?? { version: 1, userId },
    })
      .setProtectedHeader({ alg: "ES256", kid: "test-key", typ: "JWT" })
      .setIssuer(options.issuer ?? issuer)
      .setAudience(options.audience ?? clientId)
      .setIssuedAt(now)
      .setExpirationTime(options.expiresAt ?? now + 300)
      .sign(this.privateKey);
  }

  queueCode(code: string, access: string, refresh = `refresh-${code}`, expiresIn = 300): void {
    this.codes.set(code, { access, refresh, expiresIn });
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    this.requests.push({
      url: url.toString(),
      authorization: new Headers(init?.headers).get("Authorization"),
    });
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({ jwks_uri: `${issuer}/.well-known/jwks.json` });
    }
    if (url.pathname === "/.well-known/jwks.json") {
      return Response.json({ keys: [this.jwk] });
    }
    if (url.pathname !== "/token" || init?.method !== "POST") {
      return new Response("Not Found", { status: 404 });
    }

    const params = new URLSearchParams(String(init.body));
    const code = params.get("code") ?? "";
    this.exchanges.push({
      code,
      redirectUri: params.get("redirect_uri") ?? "",
      verifier: params.get("code_verifier") ?? "",
    });
    const tokens = this.codes.get(code);
    return tokens
      ? Response.json({
          access_token: tokens.access,
          refresh_token: tokens.refresh,
          expires_in: tokens.expiresIn,
        })
      : Response.json({ error: "invalid_grant" }, { status: 400 });
  }
}

const setCookies = (response: Response): string[] => {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (headers.getSetCookie) return headers.getSetCookie();
  const raw = headers.get("Set-Cookie");
  return raw ? raw.split(/, (?=__Host-)/) : [];
};

const cookie = (cookies: readonly string[], name: string): string => {
  const found = cookies.find((value) => value.startsWith(`${name}=`));
  if (!found) throw new Error(`Expected ${name} cookie.`);
  return found.split(";", 1)[0];
};

const createEnv = (
  database: MemoryD1Database,
  authority: FakeOpenAuthFetcher,
  bucket?: MemoryR2Bucket,
): OpenAuthBffEnvironment => ({
  DB: database as unknown as D1Database,
  OPENAUTH_ISSUER_URL: issuer,
  OPENAUTH_CLIENT_ID: clientId,
  OPENAUTH_AUDIENCE: clientId,
  OPENAUTH_BFF_ORIGIN: appOrigin,
  OPENAUTH_AUTHORITY: authority,
  ...(bucket ? { R2_BUCKET: bucket } : {}),
});

const routeContext = (request: Request, env: OpenAuthBffEnvironment) =>
  ({ request, env }) as never;

const loginFlow = async (
  env: OpenAuthBffEnvironment,
  returnTo = "/",
): Promise<{
  state: string;
  nonce: string;
  transactionCookie: string;
  transactionSetCookie: string;
}> => {
  const response = await login(
    routeContext(
      new Request(`${appOrigin}/api/auth/open/login?returnTo=${encodeURIComponent(returnTo)}`),
      env,
    ),
  );
  const location = new URL(response.headers.get("Location") ?? "");
  const transactionSetCookie = setCookies(response).find((value) =>
    value.startsWith(`${transactionCookieName}=`),
  );
  if (!transactionSetCookie) throw new Error("Expected authorization transaction cookie.");
  const transactionCookie = cookie([transactionSetCookie], transactionCookieName);
  return {
    state: location.searchParams.get("state") ?? "",
    nonce: location.searchParams.get("nonce") ?? "",
    transactionCookie,
    transactionSetCookie,
  };
};

const callbackRequest = (code: string, state: string, transactionCookie: string): Request =>
  new Request(`${appOrigin}/api/auth/open/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, {
    headers: { Cookie: transactionCookie },
  });

describe("functions OpenAuth Pages BFF contracts", () => {
  it("fails closed with a structured 503 when authority configuration is absent", async () => {
    const response = await login(
      routeContext(
        new Request(`${appOrigin}/api/auth/open/login`),
        { DB: new MemoryD1Database() as unknown as D1Database },
      ),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "open_auth_unavailable",
      reason: "authority_configuration_missing",
    });
  });

  it("rejects malformed return paths before creating a transaction", async () => {
    const database = new MemoryD1Database();
    const authority = await FakeOpenAuthFetcher.create();
    const response = await login(
      routeContext(
        new Request(`${appOrigin}/api/auth/open/login?returnTo=https%3A%2F%2Fevil.test`),
        createEnv(database, authority),
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_return_to" });
    expect(database.transactions.size).toBe(0);
  });

  it("stores only a state hash and rejects mismatched state before code exchange", async () => {
    const database = new MemoryD1Database();
    const authority = await FakeOpenAuthFetcher.create();
    const env = createEnv(database, authority);
    const flow = await loginFlow(env, "/library?view=private");

    expect(flow.state).toHaveLength(86);
    expect(flow.nonce).toHaveLength(43);
    expect(flow.state.startsWith(flow.nonce)).toBe(true);
    expect(flow.transactionSetCookie).toContain("Path=/");
    expect(flow.transactionSetCookie).toContain("Secure");
    expect(flow.transactionSetCookie).toContain("HttpOnly");
    expect(flow.transactionSetCookie).toContain("SameSite=Lax");
    expect(flow.transactionSetCookie).not.toContain("Domain=");
    expect([...database.transactions.keys()]).not.toContain(flow.state);
    expect(database.transactions.size).toBe(1);

    const mismatchedNonce = `${flow.state.startsWith("x") ? "y" : "x"}${flow.state.slice(1)}`;
    const response = await callback(
      routeContext(callbackRequest("code-state-mismatch", mismatchedNonce, flow.transactionCookie), env),
    );

    expect(response.status).toBe(400);
    expect(authority.exchanges).toEqual([]);
    expect(database.transactions.size).toBe(1);
  });

  it("rejects a callback whose BFF transaction cookie lacks the PKCE verifier", async () => {
    const database = new MemoryD1Database();
    const authority = await FakeOpenAuthFetcher.create();
    const env = createEnv(database, authority);
    const flow = await loginFlow(env);
    const [, encoded] = flow.transactionCookie.split("=");
    const altered = JSON.parse(Buffer.from(encoded, "base64url").toString()) as Record<string, unknown>;
    delete altered.verifier;
    const missingVerifierCookie = `${transactionCookieName}=${Buffer.from(JSON.stringify(altered)).toString("base64url")}`;

    const response = await callback(
      routeContext(callbackRequest("code-missing-verifier", flow.state, missingVerifierCookie), env),
    );

    expect(response.status).toBe(400);
    expect(authority.exchanges).toEqual([]);
    expect(database.transactions.size).toBe(1);
  });

  it("exchanges a one-time code, maps a stable identity, and exposes only the internal principal", async () => {
    const database = new MemoryD1Database();
    const bucket = new MemoryR2Bucket();
    const authority = await FakeOpenAuthFetcher.create();
    const env = createEnv(database, authority, bucket);
    const flow = await loginFlow(env, "/restore?step=confirm");
    authority.queueCode("code-success", await authority.issueAccessToken("user_recoverable"));

    const callbackResponse = await callback(
      routeContext(callbackRequest("code-success", flow.state, flow.transactionCookie), env),
    );
    const callbackCookies = setCookies(callbackResponse);

    expect(callbackResponse.status).toBe(302);
    expect(callbackResponse.headers.get("Location")).toBe("/restore?step=confirm");
    expect(authority.exchanges).toEqual([
      expect.objectContaining({
        code: "code-success",
        redirectUri: `${appOrigin}/api/auth/open/callback`,
      }),
    ]);
    expect(authority.exchanges[0]?.verifier).toHaveLength(64);
    expect(callbackCookies).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${accessCookieName}=`),
        expect.stringContaining(`${refreshCookieName}=`),
        expect.stringContaining(`${transactionCookieName}=; Max-Age=0`),
      ]),
    );
    for (const value of callbackCookies) {
      expect(value).toContain("Path=/");
      expect(value).toContain("Secure");
      expect(value).toContain("HttpOnly");
      expect(value).toContain("SameSite=Lax");
      expect(value).not.toContain("Domain=");
    }
    expect(database.users).toEqual(new Set(["user_recoverable"]));
    expect(database.identities.size).toBe(1);
    expect(database.legacyWriteCount).toBe(0);
    expect(bucket.writeCount).toBe(0);
    expect(authority.requests.every((request) => request.authorization === null)).toBe(true);

    const principalResponse = await principal(
      routeContext(
        new Request(`${appOrigin}/api/auth/open/principal`, {
          headers: { Cookie: cookie(callbackCookies, accessCookieName) },
        }),
        env,
      ),
    );
    expect(principalResponse.status).toBe(200);
    await expect(principalResponse.json()).resolves.toEqual({
      authenticated: true,
      userId: "user_recoverable",
    });
  });

  it("maps the same verified external identity to the same user id across callbacks", async () => {
    const database = new MemoryD1Database();
    const authority = await FakeOpenAuthFetcher.create();
    const env = createEnv(database, authority);
    const first = await loginFlow(env);
    const second = await loginFlow(env);
    const token = await authority.issueAccessToken("user_same_identity");
    authority.queueCode("code-first", token);
    authority.queueCode("code-second", token);

    expect(
      (
        await callback(routeContext(callbackRequest("code-first", first.state, first.transactionCookie), env))
      ).status,
    ).toBe(302);
    expect(
      (
        await callback(routeContext(callbackRequest("code-second", second.state, second.transactionCookie), env))
      ).status,
    ).toBe(302);
    expect(database.users).toEqual(new Set(["user_same_identity"]));
    expect(database.identities.size).toBe(1);
  });

  it("consumes each callback transaction before exchange so replay cannot call the authority twice", async () => {
    const database = new MemoryD1Database();
    const authority = await FakeOpenAuthFetcher.create();
    const env = createEnv(database, authority);
    const flow = await loginFlow(env);
    authority.queueCode("code-replay", await authority.issueAccessToken());
    const request = callbackRequest("code-replay", flow.state, flow.transactionCookie);

    expect((await callback(routeContext(request, env))).status).toBe(302);
    expect((await callback(routeContext(request, env))).status).toBe(400);
    expect(authority.exchanges).toHaveLength(1);
    expect(database.transactions.size).toBe(0);
  });

  it.each([
    ["expired", async (authority: FakeOpenAuthFetcher) => authority.issueAccessToken("user_01", { expiresAt: Math.floor(Date.now() / 1000) - 1 })],
    ["forged", async (authority: FakeOpenAuthFetcher) => `${await authority.issueAccessToken()}x`],
    ["wrong issuer", async (authority: FakeOpenAuthFetcher) => authority.issueAccessToken("user_01", { issuer: "https://other-issuer.test" })],
    ["wrong audience", async (authority: FakeOpenAuthFetcher) => authority.issueAccessToken("user_01", { audience: "other-client" })],
  ])("rejects %s access tokens without creating a user principal", async (_name, createToken) => {
    const database = new MemoryD1Database();
    const authority = await FakeOpenAuthFetcher.create();
    const env = createEnv(database, authority);
    const flow = await loginFlow(env);
    authority.queueCode("code-invalid-token", await createToken(authority));

    const response = await callback(
      routeContext(callbackRequest("code-invalid-token", flow.state, flow.transactionCookie), env),
    );

    expect(response.status).toBe(401);
    expect(database.users.size).toBe(0);
    expect(database.identities.size).toBe(0);
    expect(setCookies(response)).toEqual(
      expect.arrayContaining([expect.stringContaining(`${transactionCookieName}=; Max-Age=0`)]),
    );
  });

  it("returns anonymous for invalid access cookies without returning refresh material", async () => {
    const database = new MemoryD1Database();
    const authority = await FakeOpenAuthFetcher.create();
    const env = createEnv(database, authority);
    const response = await principal(
      routeContext(
        new Request(`${appOrigin}/api/auth/open/principal`, {
          headers: { Cookie: `${accessCookieName}=forged; ${refreshCookieName}=secret-refresh` },
        }),
        env,
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ authenticated: false });
    expect(response.headers.get("Set-Cookie")).not.toContain("secret-refresh");
  });

  it("requires same-origin POST logout and clears only BFF cookies", async () => {
    const database = new MemoryD1Database();
    const authority = await FakeOpenAuthFetcher.create();
    const env = createEnv(database, authority);
    const invalidOrigin = await logout(
      routeContext(
        new Request(`${appOrigin}/api/auth/open/logout`, { method: "POST", headers: { Origin: "https://evil.test" } }),
        env,
      ),
    );
    const response = await logout(
      routeContext(
        new Request(`${appOrigin}/api/auth/open/logout`, { method: "POST", headers: { Origin: appOrigin } }),
        env,
      ),
    );
    const method = await logoutRoute(
      routeContext(new Request(`${appOrigin}/api/auth/open/logout`, { method: "GET" }), env),
    );

    expect(invalidOrigin.status).toBe(403);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(setCookies(response)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${accessCookieName}=; Max-Age=0`),
        expect.stringContaining(`${refreshCookieName}=; Max-Age=0`),
        expect.stringContaining(`${transactionCookieName}=; Max-Age=0`),
      ]),
    );
    expect(method.status).toBe(405);
    expect((await callbackRoute(routeContext(new Request(`${appOrigin}/api/auth/open/callback`, { method: "POST" }), env))).status).toBe(405);
  });
});

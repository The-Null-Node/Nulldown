import type { D1Database } from "@cloudflare/workers-types";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import type { OpenAuthBffEnvironment } from "../../../_lib/accounts/open-auth/service";
import { onRequestGet as login } from "../login";

export const appOrigin = "https://app.test";
const issuer = "https://issuer.test";
const clientId = "nulldown-browser-v1";
export const transactionCookieName = "__Host-nulldown-open-auth-transaction";
export const accessCookieName = "__Host-nulldown-open-auth-access";
export const refreshCookieName = "__Host-nulldown-open-auth-refresh";

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

export class MemoryD1Database {
  readonly sqlLog: string[] = [];
  readonly users = new Set<string>();
  readonly transactions = new Map<string, CallbackTransactionRow>();
  legacyWriteCount = 0;
  principalWriteCount = 0;

  prepare(sql: string): MemoryD1Statement {
    return new MemoryD1Statement(this, sql);
  }

  run(sql: string, params: unknown[]): void {
    this.sqlLog.push(sql);
    if (
      /\b(?:accounts|branches|drops)\b/i.test(sql) &&
      !sql.includes("auth_")
    ) {
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
      this.principalWriteCount += 1;
      this.users.add(String(params[0]));
      return;
    }
    if (sql.includes("INSERT INTO auth_external_identities")) {
      this.principalWriteCount += 1;
    }
  }

  first(sql: string, params: unknown[]): unknown {
    if (sql.includes("DELETE FROM auth_callback_transactions")) {
      const stateHash = String(params[0]);
      const transaction = this.transactions.get(stateHash);
      if (!transaction || transaction.expires_at <= Number(params[1])) {
        return null;
      }
      this.transactions.delete(stateHash);
      return { return_to: transaction.return_to };
    }
    if (sql.includes("FROM auth_users")) {
      const userId = String(params[0]);
      return this.users.has(userId) ? { user_id: userId } : null;
    }
    return null;
  }
}

export class MemoryR2Bucket {
  writeCount = 0;

  async put(): Promise<null> {
    this.writeCount += 1;
    return null;
  }
}

export class FakeOpenAuthFetcher {
  readonly requests: Array<{ url: string; authorization: string | null }> = [];
  readonly exchanges: Array<{
    code: string;
    redirectUri: string;
    verifier: string;
  }> = [];
  readonly refreshes: string[] = [];
  private readonly codes = new Map<
    string,
    { access: string; refresh: string; expiresIn: number }
  >();
  private readonly refreshTokens = new Map<
    string,
    { access: string; refresh: string; expiresIn: number }
  >();

  private constructor(
    private readonly privateKey: CryptoKey,
    private readonly jwk: JsonWebKey,
  ) {}

  static async create(): Promise<FakeOpenAuthFetcher> {
    const pair = await generateKeyPair("ES256");
    const jwk = {
      ...(await exportJWK(pair.publicKey)),
      kid: "test-key",
      alg: "ES256",
    } as unknown as JsonWebKey;
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

  queueCode(
    code: string,
    access: string,
    refresh = `refresh-${code}`,
    expiresIn = 300,
  ): void {
    this.codes.set(code, { access, refresh, expiresIn });
  }

  queueRefresh(
    refresh: string,
    access: string,
    nextRefresh = `next-${refresh}`,
    expiresIn = 300,
  ): void {
    this.refreshTokens.set(refresh, {
      access,
      refresh: nextRefresh,
      expiresIn,
    });
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
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
    if (params.get("grant_type") === "refresh_token") {
      const refresh = params.get("refresh_token") ?? "";
      this.refreshes.push(refresh);
      const tokens = this.refreshTokens.get(refresh);
      return tokens
        ? Response.json({
            access_token: tokens.access,
            refresh_token: tokens.refresh,
            expires_in: tokens.expiresIn,
          })
        : Response.json({ error: "invalid_grant" }, { status: 400 });
    }

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

export const setCookies = (response: Response): string[] => {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  if (headers.getSetCookie) return headers.getSetCookie();
  const raw = headers.get("Set-Cookie");
  return raw ? raw.split(/, (?=__Host-)/) : [];
};

export const cookie = (cookies: readonly string[], name: string): string => {
  const found = cookies.find((value) => value.startsWith(`${name}=`));
  if (!found) throw new Error(`Expected ${name} cookie.`);
  return found.split(";", 1)[0];
};

export const createEnv = (
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

export const routeContext = (request: Request, env: OpenAuthBffEnvironment) =>
  ({ request, env }) as never;

export const loginFlow = async (
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
      new Request(
        `${appOrigin}/api/auth/open/login?returnTo=${encodeURIComponent(returnTo)}`,
      ),
      env,
    ),
  );
  const location = new URL(response.headers.get("Location") ?? "");
  const transactionSetCookie = setCookies(response).find((value) =>
    value.startsWith(`${transactionCookieName}=`),
  );
  if (!transactionSetCookie) {
    throw new Error("Expected authorization transaction cookie.");
  }
  const transactionCookie = cookie(
    [transactionSetCookie],
    transactionCookieName,
  );
  return {
    state: location.searchParams.get("state") ?? "",
    nonce: location.searchParams.get("nonce") ?? "",
    transactionCookie,
    transactionSetCookie,
  };
};

export const callbackRequest = (
  code: string,
  state: string,
  transactionCookie: string,
): Request =>
  new Request(
    `${appOrigin}/api/auth/open/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    {
      headers: { Cookie: transactionCookie },
    },
  );

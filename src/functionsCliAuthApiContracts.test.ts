import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import type { D1Database } from "@cloudflare/workers-types";

import {
  approveCliDeviceResponse,
  createCliDeviceResponse,
  pollCliDeviceResponse,
  refreshCliCredentialResponse,
  revokeCliCredentialResponse,
  type CliAuthEnvironment,
} from "../functions/api/_lib/accounts/cliAuth/service";
import { generateCliDeviceKeyPair, decryptCliCredentialEnvelope } from "./cli/auth";
import {
  CLI_CREDENTIAL_KIND_V1,
  isCliCredentialBundle,
  type CliCredentialBundleV1,
  type CliDeviceStartResponse,
} from "../shared/auth/cliDevice";

const appOrigin = "https://nulldown.app";
const issuer = "https://issuer.test";
const openAuthClientId = "nulldown-cli-test";
const accessCookieName = "__Host-nulldown-open-auth-access";

interface Ticket {
  ticket_id: string;
  device_code_hash: string;
  user_code_hash: string;
  client_public_jwk_json: string;
  client_name: string | null;
  created_at: number;
  expires_at: number;
  approved_user_id: string | null;
  approved_account_id: string | null;
  approved_at: number | null;
  redeemed_at: number | null;
}

interface Credential {
  credential_id: string;
  ticket_id: string;
  user_id: string;
  account_id: string;
  refresh_token_hash: string;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

class MemoryStatement {
  private params: unknown[] = [];

  constructor(
    private readonly database: MemoryDatabase,
    private readonly sql: string,
  ) {}

  bind(...params: unknown[]): this {
    this.params = params;
    return this;
  }

  async run(): Promise<{ meta: { changes: number } }> {
    return { meta: { changes: this.database.run(this.sql, this.params) } };
  }

  async first<T>(): Promise<T | null> {
    return this.database.first(this.sql, this.params) as T | null;
  }
}

class MemoryDatabase {
  readonly tickets = new Map<string, Ticket>();
  readonly credentials = new Map<string, Credential>();
  readonly users = new Set<string>();
  readonly accountBindings = new Map<string, string>();

  prepare(sql: string): MemoryStatement {
    return new MemoryStatement(this, sql);
  }

  async batch(statements: MemoryStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    const results: Array<{ meta: { changes: number } }> = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  run(sql: string, params: unknown[]): number {
    if (sql.includes("INSERT INTO auth_cli_device_tickets")) {
      const ticket: Ticket = {
        ticket_id: String(params[0]),
        device_code_hash: String(params[1]),
        user_code_hash: String(params[2]),
        client_public_jwk_json: String(params[3]),
        client_name: params[4] === null ? null : String(params[4]),
        created_at: Number(params[5]),
        expires_at: Number(params[6]),
        approved_user_id: null,
        approved_account_id: null,
        approved_at: null,
        redeemed_at: null,
      };
      this.tickets.set(ticket.ticket_id, ticket);
      return 1;
    }
    if (sql.includes("INSERT OR IGNORE INTO auth_cli_credentials")) {
      const ticket = this.tickets.get(String(params[5]));
      if (
        !ticket ||
        ticket.device_code_hash !== String(params[6]) ||
        ticket.approved_user_id === null ||
        ticket.approved_account_id === null ||
        ticket.approved_at === null ||
        ticket.redeemed_at !== null ||
        ticket.expires_at <= Number(params[7]) ||
        this.credentials.has(String(params[0]))
      ) {
        return 0;
      }
      const credential: Credential = {
        credential_id: String(params[0]),
        ticket_id: ticket.ticket_id,
        user_id: ticket.approved_user_id,
        account_id: ticket.approved_account_id,
        refresh_token_hash: String(params[1]),
        created_at: Number(params[2]),
        expires_at: Number(params[3]),
        last_used_at: Number(params[4]),
        revoked_at: null,
      };
      this.credentials.set(credential.credential_id, credential);
      return 1;
    }
    if (sql.includes("UPDATE auth_cli_device_tickets")) {
      const ticket = this.tickets.get(String(params[1]));
      if (
        !ticket ||
        ticket.device_code_hash !== String(params[2]) ||
        ticket.approved_at === null ||
        ticket.redeemed_at !== null ||
        ticket.expires_at <= Number(params[3])
      ) {
        return 0;
      }
      ticket.redeemed_at = Number(params[0]);
      return 1;
    }
    return 0;
  }

  first(sql: string, params: unknown[]): unknown {
    if (sql.includes("SET approved_user_id")) {
      const ticket = this.tickets.get(String(params[3]));
      const approvedAt = Number(params[4]);
      if (
        !ticket ||
        ticket.approved_at !== null ||
        ticket.redeemed_at !== null ||
        ticket.expires_at <= approvedAt
      ) {
        return null;
      }
      ticket.approved_user_id = String(params[0]);
      ticket.approved_account_id = String(params[1]);
      ticket.approved_at = approvedAt;
      return { ticket_id: ticket.ticket_id };
    }
    if (sql.includes("FROM auth_users")) {
      const userId = String(params[0]);
      return this.users.has(userId) ? { user_id: userId } : null;
    }
    if (sql.includes("FROM auth_account_bindings")) {
      const accountId = String(params[0]);
      const userId = this.accountBindings.get(accountId);
      return userId
        ? {
            account_id: accountId,
            user_id: userId,
            signing_key_fingerprint: "test-fingerprint",
            created_at: 1,
            updated_at: 1,
          }
        : null;
    }
    if (sql.includes("FROM auth_cli_device_tickets")) {
      const value = String(params[0]);
      return [...this.tickets.values()].find(
        (ticket) =>
          (sql.includes("device_code_hash") && ticket.device_code_hash === value) ||
          (sql.includes("user_code_hash") && ticket.user_code_hash === value),
      ) ?? null;
    }
    if (sql.includes("FROM auth_cli_credentials")) {
      const value = String(params[0]);
      return [...this.credentials.values()].find(
        (credential) => credential.refresh_token_hash === value,
      ) ?? null;
    }
    if (sql.includes("UPDATE auth_cli_credentials")) {
      if (sql.includes("COALESCE(revoked_at")) {
        const credential = [...this.credentials.values()].find(
          (value) => value.refresh_token_hash === String(params[1]),
        );
        if (!credential) return null;
        credential.revoked_at ??= Number(params[0]);
        return { credential_id: credential.credential_id };
      }
      const credential = this.credentials.get(String(params[2]));
      if (
        !credential ||
        credential.refresh_token_hash !== String(params[3]) ||
        credential.revoked_at !== null ||
        credential.expires_at <= Number(params[4])
      ) {
        return null;
      }
      credential.refresh_token_hash = String(params[0]);
      credential.last_used_at = Number(params[1]);
      return { credential_id: credential.credential_id };
    }
    return null;
  }
}

class FakeOpenAuthAuthority {
  private constructor(
    private readonly privateKey: KeyLike | CryptoKey,
    private readonly jwk: JsonWebKey,
  ) {}

  static async create(): Promise<FakeOpenAuthAuthority> {
    const pair = await generateKeyPair("ES256");
    const jwk = await exportJWK(pair.publicKey);
    jwk.kid = "test-key";
    jwk.alg = "ES256";
    return new FakeOpenAuthAuthority(pair.privateKey, jwk);
  }

  async issueAccessToken(userId: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      mode: "access",
      type: "nulldown-user",
      properties: { version: 1, userId },
    })
      .setProtectedHeader({ alg: "ES256", kid: "test-key", typ: "JWT" })
      .setIssuer(issuer)
      .setAudience(openAuthClientId)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(this.privateKey);
  }

  async fetch(input: RequestInfo | URL): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({ jwks_uri: `${issuer}/.well-known/jwks.json` });
    }
    if (url.pathname === "/.well-known/jwks.json") {
      return Response.json({ keys: [this.jwk] });
    }
    return new Response("Not Found", { status: 404 });
  }
}

const responseJson = async <T>(response: Response): Promise<T> =>
  (await response.json()) as T;

describe("CLI auth Pages service", () => {
  it("issues isolated tickets, approves through OpenAuth, redeems once, rotates, and revokes", async () => {
    const database = new MemoryDatabase();
    database.users.add("user-1");
    database.accountBindings.set("account-1", "user-1");
    const authority = await FakeOpenAuthAuthority.create();
    const accessToken = await authority.issueAccessToken("user-1");
    const firstKeyPair = await generateCliDeviceKeyPair();
    const secondKeyPair = await generateCliDeviceKeyPair();
    const env = {
      DB: database as unknown as D1Database,
      ACCOUNT_AUTH_SECRET: "account-secret-for-cli-tests",
      OPENAUTH_ISSUER_URL: issuer,
      OPENAUTH_CLIENT_ID: openAuthClientId,
      OPENAUTH_AUDIENCE: openAuthClientId,
      OPENAUTH_BFF_ORIGIN: appOrigin,
      OPENAUTH_AUTHORITY: authority,
    } satisfies CliAuthEnvironment;
    const firstStarted = await createCliDeviceResponse(
      env,
      new Request(`${appOrigin}/api/auth/cli/device`, {
        method: "POST",
        body: JSON.stringify({ publicKey: firstKeyPair.publicKey, clientName: "test-cli" }),
      }),
    );
    expect(firstStarted.status).toBe(201);
    const firstDevice = await responseJson<CliDeviceStartResponse>(firstStarted);
    const secondStarted = await createCliDeviceResponse(
      env,
      new Request(`${appOrigin}/api/auth/cli/device`, {
        method: "POST",
        body: JSON.stringify({ publicKey: secondKeyPair.publicKey, clientName: "second-cli" }),
      }),
    );
    expect(secondStarted.status).toBe(201);
    const secondDevice = await responseJson<CliDeviceStartResponse>(secondStarted);
    expect(firstDevice.verificationUri).toBe(`${appOrigin}/auth/cli`);
    expect(secondDevice.verificationUri).toBe(`${appOrigin}/auth/cli`);
    expect(firstDevice.verificationUri).not.toContain("code");
    expect(secondDevice.verificationUri).not.toContain("code");

    const approve = (userCode: string): Promise<Response> =>
      approveCliDeviceResponse(
        env,
        new Request(`${appOrigin}/api/auth/cli/approve`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: `${accessCookieName}=${accessToken}`,
            Origin: appOrigin,
          },
          body: JSON.stringify({ userCode, accountId: "account-1" }),
        }),
      );

    const mutatedCode = `${firstDevice.userCode.slice(0, -1)}${
      firstDevice.userCode.endsWith("2") ? "3" : "2"
    }`;
    const mutated = await approve(mutatedCode);
    expect(mutated.status).toBe(409);
    await expect(mutated.json()).resolves.toEqual({ error: "invalid_or_expired_cli_code" });
    expect([...database.tickets.values()].every((ticket) => ticket.approved_at === null)).toBe(true);

    const approved = await approve(firstDevice.userCode);
    expect(approved.status).toBe(200);
    await expect(approved.json()).resolves.toEqual({ approved: true, accountId: "account-1" });
    const tickets = [...database.tickets.values()];
    expect(tickets[0]?.approved_user_id).toBe("user-1");
    expect(tickets[1]?.approved_at).toBeNull();

    const pending = await pollCliDeviceResponse(
      env,
      new Request("https://nulldown.app/api/auth/cli/poll", {
        method: "POST",
        body: JSON.stringify({ deviceCode: secondDevice.deviceCode }),
      }),
    );
    expect(await responseJson(pending)).toEqual(expect.objectContaining({ status: "pending" }));

    const secondTicket = tickets[1]!;
    secondTicket.expires_at = Date.now();
    const expired = await approve(secondDevice.userCode);
    expect(expired.status).toBe(409);
    await expect(expired.json()).resolves.toEqual({ error: "invalid_or_expired_cli_code" });
    expect(secondTicket.approved_at).toBeNull();

    const approvedPoll = await pollCliDeviceResponse(
      env,
      new Request(`${appOrigin}/api/auth/cli/poll`, {
        method: "POST",
        body: JSON.stringify({ deviceCode: firstDevice.deviceCode }),
      }),
    );
    const approvedBody = await responseJson<{
      status: "approved";
      envelope: Parameters<typeof decryptCliCredentialEnvelope>[0];
    }>(approvedPoll);
    expect(approvedBody.status).toBe("approved");
    const credential = await decryptCliCredentialEnvelope(
      approvedBody.envelope,
      firstKeyPair.privateKey,
    );
    expect(credential.accountId).toBe("account-1");
    expect(credential.accessToken).toMatch(/^ndacc\.v1\./);

    const replay = await pollCliDeviceResponse(
      env,
      new Request(`${appOrigin}/api/auth/cli/poll`, {
        method: "POST",
        body: JSON.stringify({ deviceCode: firstDevice.deviceCode }),
      }),
    );
    expect(replay.status).toBe(409);

    const refreshed = await refreshCliCredentialResponse(
      env,
      new Request(`${appOrigin}/api/auth/cli/refresh`, {
        method: "POST",
        body: JSON.stringify({ refreshToken: credential.refreshToken }),
      }),
    );
    expect(refreshed.status).toBe(200);
    const refreshedBody = await responseJson<CliCredentialBundleV1>(refreshed);
    expect(refreshedBody.kind).toBe(CLI_CREDENTIAL_KIND_V1);
    expect(refreshedBody.version).toBe(1);
    expect(isCliCredentialBundle(refreshedBody)).toBe(true);
    expect(refreshedBody.refreshToken).not.toBe(credential.refreshToken);
    expect(refreshedBody.accountId).toBe("account-1");

    const staleRefresh = await refreshCliCredentialResponse(
      env,
      new Request(`${appOrigin}/api/auth/cli/refresh`, {
        method: "POST",
        body: JSON.stringify({ refreshToken: credential.refreshToken }),
      }),
    );
    expect(staleRefresh.status).toBe(401);

    const refreshedAgain = await refreshCliCredentialResponse(
      env,
      new Request(`${appOrigin}/api/auth/cli/refresh`, {
        method: "POST",
        body: JSON.stringify({ refreshToken: refreshedBody.refreshToken }),
      }),
    );
    expect(refreshedAgain.status).toBe(200);
    const refreshedAgainBody = await responseJson<CliCredentialBundleV1>(refreshedAgain);
    expect(isCliCredentialBundle(refreshedAgainBody)).toBe(true);

    const revoked = await revokeCliCredentialResponse(
      env,
      new Request(`${appOrigin}/api/auth/cli/revoke`, {
        method: "POST",
        body: JSON.stringify({ refreshToken: refreshedAgainBody.refreshToken }),
      }),
    );
    expect(revoked.status).toBe(204);
    const afterRevoke = await refreshCliCredentialResponse(
      env,
      new Request(`${appOrigin}/api/auth/cli/refresh`, {
        method: "POST",
        body: JSON.stringify({ refreshToken: refreshedAgainBody.refreshToken }),
      }),
    );
    expect(afterRevoke.status).toBe(401);
  });
});

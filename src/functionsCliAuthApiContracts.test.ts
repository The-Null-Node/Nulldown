import type { D1Database } from "@cloudflare/workers-types";

import {
  createCliDeviceResponse,
  pollCliDeviceResponse,
  refreshCliCredentialResponse,
  revokeCliCredentialResponse,
  type CliAuthEnvironment,
} from "../functions/api/_lib/accounts/cliAuth/service";
import { generateCliDeviceKeyPair, decryptCliCredentialEnvelope } from "./cli/auth";
import type { CliCredentialBundleV1 } from "../shared/auth/cliDevice";

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

const responseJson = async <T>(response: Response): Promise<T> =>
  (await response.json()) as T;

describe("CLI auth Pages service", () => {
  it("issues a pending ticket, redeems approval once, rotates, and revokes", async () => {
    const database = new MemoryDatabase();
    const keyPair = await generateCliDeviceKeyPair();
    const env = {
      DB: database as unknown as D1Database,
      ACCOUNT_AUTH_SECRET: "account-secret-for-cli-tests",
    } satisfies CliAuthEnvironment;
    const started = await createCliDeviceResponse(
      env,
      new Request("https://nulldown.app/api/auth/cli/device", {
        method: "POST",
        body: JSON.stringify({ publicKey: keyPair.publicKey, clientName: "test-cli" }),
      }),
    );
    expect(started.status).toBe(201);
    const device = await responseJson<{
      deviceCode: string;
      userCode: string;
    }>(started);
    const pending = await pollCliDeviceResponse(
      env,
      new Request("https://nulldown.app/api/auth/cli/poll", {
        method: "POST",
        body: JSON.stringify({ deviceCode: device.deviceCode }),
      }),
    );
    expect(await responseJson(pending)).toEqual(expect.objectContaining({ status: "pending" }));

    const ticket = [...database.tickets.values()][0]!;
    ticket.approved_user_id = "user-1";
    ticket.approved_account_id = "account-1";
    ticket.approved_at = Date.now();
    const approved = await pollCliDeviceResponse(
      env,
      new Request("https://nulldown.app/api/auth/cli/poll", {
        method: "POST",
        body: JSON.stringify({ deviceCode: device.deviceCode }),
      }),
    );
    const approvedBody = await responseJson<{
      status: "approved";
      envelope: Parameters<typeof decryptCliCredentialEnvelope>[0];
    }>(approved);
    expect(approvedBody.status).toBe("approved");
    const credential = await decryptCliCredentialEnvelope(
      approvedBody.envelope,
      keyPair.privateKey,
    );
    expect(credential.accountId).toBe("account-1");
    expect(credential.accessToken).toMatch(/^ndacc\.v1\./);

    const replay = await pollCliDeviceResponse(
      env,
      new Request("https://nulldown.app/api/auth/cli/poll", {
        method: "POST",
        body: JSON.stringify({ deviceCode: device.deviceCode }),
      }),
    );
    expect(replay.status).toBe(409);

    const refreshed = await refreshCliCredentialResponse(
      env,
      new Request("https://nulldown.app/api/auth/cli/refresh", {
        method: "POST",
        body: JSON.stringify({ refreshToken: credential.refreshToken }),
      }),
    );
    const refreshedBody = await responseJson<CliCredentialBundleV1>(refreshed);
    expect(refreshedBody.refreshToken).not.toBe(credential.refreshToken);
    expect(refreshedBody.accountId).toBe("account-1");

    const revoked = await revokeCliCredentialResponse(
      env,
      new Request("https://nulldown.app/api/auth/cli/revoke", {
        method: "POST",
        body: JSON.stringify({ refreshToken: refreshedBody.refreshToken }),
      }),
    );
    expect(revoked.status).toBe(204);
    const afterRevoke = await refreshCliCredentialResponse(
      env,
      new Request("https://nulldown.app/api/auth/cli/refresh", {
        method: "POST",
        body: JSON.stringify({ refreshToken: refreshedBody.refreshToken }),
      }),
    );
    expect(afterRevoke.status).toBe(401);
  });
});

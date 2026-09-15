import type { D1Database } from "@cloudflare/workers-types";

import type { CliEncryptionPublicJwk } from "../../../../../shared/auth/cliDevice";
import type { DropDeviceDelegation } from "../../../../../shared/drop/deviceDelegation";

export interface CliDeviceTicketRow {
  ticket_id: string;
  device_code_hash: string;
  user_code_hash: string;
  client_public_jwk_json: string;
  client_name: string | null;
  authoring_requested: number;
  delegate_signing_public_jwk_json: string | null;
  credential_id: string | null;
  credential_expires_at: number | null;
  device_delegation_json: string | null;
  created_at: number;
  expires_at: number;
  approved_user_id: string | null;
  approved_account_id: string | null;
  approved_at: number | null;
  redeemed_at: number | null;
}

export interface CliCredentialRow {
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

/** Persists a new one-time CLI authorization ticket. */
export const insertCliDeviceTicket = (
  db: D1Database,
  row: {
    ticketId: string;
    deviceCodeHash: string;
    userCodeHash: string;
    publicKey: CliEncryptionPublicJwk;
    clientName: string | null;
    delegateSigningPublicJwk: JsonWebKey | null;
    credentialId: string;
    credentialExpiresAt: number;
    createdAt: number;
    expiresAt: number;
  },
): Promise<void> =>
  db
    .prepare(
      `INSERT INTO auth_cli_device_tickets
         (ticket_id, device_code_hash, user_code_hash, client_public_jwk_json,
          client_name, authoring_requested, delegate_signing_public_jwk_json,
          credential_id, credential_expires_at, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.ticketId,
      row.deviceCodeHash,
      row.userCodeHash,
      JSON.stringify(row.publicKey),
      row.clientName,
      row.delegateSigningPublicJwk ? 1 : 0,
      row.delegateSigningPublicJwk ? JSON.stringify(row.delegateSigningPublicJwk) : null,
      row.credentialId,
      row.credentialExpiresAt,
      row.createdAt,
      row.expiresAt,
    )
    .run()
    .then(() => undefined);

/** Reads a device ticket by the hash of its private device code. */
export const readCliDeviceTicketByDeviceHash = (
  db: D1Database,
  deviceCodeHash: string,
): Promise<CliDeviceTicketRow | null> =>
  db
    .prepare(
      `SELECT ticket_id, device_code_hash, user_code_hash,
               client_public_jwk_json, client_name, authoring_requested,
               delegate_signing_public_jwk_json, credential_id, credential_expires_at,
               device_delegation_json, created_at, expires_at,
              approved_user_id, approved_account_id, approved_at, redeemed_at
       FROM auth_cli_device_tickets
       WHERE device_code_hash = ?`,
    )
    .bind(deviceCodeHash)
    .first<CliDeviceTicketRow>();

/** Reads a device ticket by the hash of its human approval code. */
export const readCliDeviceTicketByUserHash = (
  db: D1Database,
  userCodeHash: string,
): Promise<CliDeviceTicketRow | null> =>
  db
    .prepare(
      `SELECT ticket_id, device_code_hash, user_code_hash,
               client_public_jwk_json, client_name, authoring_requested,
               delegate_signing_public_jwk_json, credential_id, credential_expires_at,
               device_delegation_json, created_at, expires_at,
              approved_user_id, approved_account_id, approved_at, redeemed_at
       FROM auth_cli_device_tickets
       WHERE user_code_hash = ?`,
    )
    .bind(userCodeHash)
    .first<CliDeviceTicketRow>();

/** Approves a pending ticket for exactly one OpenAuth user and account. */
export const approveCliDeviceTicket = (
  db: D1Database,
  input: {
    ticketId: string;
    userId: string;
    accountId: string;
    approvedAt: number;
    deviceDelegation: DropDeviceDelegation | null;
  },
): Promise<{ ticket_id: string } | null> =>
  db
    .prepare(
      `UPDATE auth_cli_device_tickets
       SET approved_user_id = ?, approved_account_id = ?, approved_at = ?,
           device_delegation_json = ?
       WHERE ticket_id = ? AND approved_at IS NULL AND redeemed_at IS NULL
         AND expires_at > ?
       RETURNING ticket_id`,
    )
    .bind(
      input.userId,
      input.accountId,
      input.approvedAt,
      input.deviceDelegation ? JSON.stringify(input.deviceDelegation) : null,
      input.ticketId,
      input.approvedAt,
    )
    .first<{ ticket_id: string }>();

/** Inserts the first credential for a device ticket and atomically redeems it. */
export const redeemCliDeviceTicket = async (
  db: D1Database,
  input: {
    ticketId: string;
    deviceCodeHash: string;
    refreshTokenHash: string;
    createdAt: number;
    redeemedAt: number;
  },
): Promise<boolean> => {
  const results = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO auth_cli_credentials
          (credential_id, ticket_id, user_id, account_id, refresh_token_hash,
           created_at, expires_at, last_used_at, revoked_at)
          SELECT credential_id, ticket_id, approved_user_id, approved_account_id, ?,
                 ?, credential_expires_at, ?, NULL
         FROM auth_cli_device_tickets
          WHERE ticket_id = ? AND device_code_hash = ?
            AND approved_user_id IS NOT NULL
            AND approved_account_id IS NOT NULL
            AND approved_at IS NOT NULL
            AND redeemed_at IS NULL
            AND expires_at > ?
            AND credential_id IS NOT NULL
            AND credential_expires_at > ?`,
      )
      .bind(
        input.refreshTokenHash,
        input.createdAt,
        input.createdAt,
        input.ticketId,
        input.deviceCodeHash,
        input.createdAt,
        input.createdAt,
      ),
    db
      .prepare(
        `UPDATE auth_cli_device_tickets
         SET redeemed_at = ?
         WHERE ticket_id = ? AND device_code_hash = ?
           AND approved_at IS NOT NULL AND redeemed_at IS NULL
           AND expires_at > ?`,
      )
      .bind(input.redeemedAt, input.ticketId, input.deviceCodeHash, input.redeemedAt),
  ]);

  return (results[0]?.meta.changes ?? 0) === 1 &&
    (results[1]?.meta.changes ?? 0) === 1;
};

/** Reads an active refresh credential by its hashed secret. */
export const readCliCredentialByRefreshHash = (
  db: D1Database,
  refreshTokenHash: string,
): Promise<CliCredentialRow | null> =>
  db
    .prepare(
      `SELECT credential_id, ticket_id, user_id, account_id,
              refresh_token_hash, created_at, expires_at, last_used_at, revoked_at
       FROM auth_cli_credentials
       WHERE refresh_token_hash = ?`,
    )
    .bind(refreshTokenHash)
    .first<CliCredentialRow>();

/** Rotates a refresh secret only if the presented credential is still current. */
export const rotateCliCredential = (
  db: D1Database,
  input: {
    credentialId: string;
    previousRefreshTokenHash: string;
    nextRefreshTokenHash: string;
    lastUsedAt: number;
  },
): Promise<{ credential_id: string } | null> =>
  db
    .prepare(
      `UPDATE auth_cli_credentials
       SET refresh_token_hash = ?, last_used_at = ?
       WHERE credential_id = ? AND refresh_token_hash = ?
         AND revoked_at IS NULL AND expires_at > ?
       RETURNING credential_id`,
    )
    .bind(
      input.nextRefreshTokenHash,
      input.lastUsedAt,
      input.credentialId,
      input.previousRefreshTokenHash,
      input.lastUsedAt,
    )
    .first<{ credential_id: string }>();

/** Revokes a refresh credential idempotently. */
export const revokeCliCredential = (
  db: D1Database,
  refreshTokenHash: string,
  revokedAt: number,
): Promise<{ credential_id: string } | null> =>
  db
    .prepare(
      `UPDATE auth_cli_credentials
       SET revoked_at = COALESCE(revoked_at, ?)
       WHERE refresh_token_hash = ?
       RETURNING credential_id`,
    )
    .bind(revokedAt, refreshTokenHash)
    .first<{ credential_id: string }>();

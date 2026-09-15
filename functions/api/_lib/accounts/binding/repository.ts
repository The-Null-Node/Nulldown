import type { D1Database } from "@cloudflare/workers-types";

export interface AccountBindingRow {
  account_id: string;
  user_id: string;
  signing_key_fingerprint: string;
  created_at: number;
  updated_at: number;
}

export interface AccountBindingChallengeRow {
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

export const readAccountBinding = (
  db: D1Database,
  accountId: string,
): Promise<AccountBindingRow | null> =>
  db
    .prepare(
      `SELECT account_id, user_id, signing_key_fingerprint, created_at, updated_at
       FROM auth_account_bindings
       WHERE account_id = ?`,
    )
    .bind(accountId)
    .first<AccountBindingRow>();

/** Lists every account explicitly bound to one authenticated OpenAuth user. */
export const listAccountBindingsForUser = (
  db: D1Database,
  userId: string,
): Promise<AccountBindingRow[]> =>
  db
    .prepare(
      `SELECT account_id, user_id, signing_key_fingerprint, created_at, updated_at
       FROM auth_account_bindings
       WHERE user_id = ?
       ORDER BY account_id ASC`,
    )
    .bind(userId)
    .all<AccountBindingRow>()
    .then((result) => result.results ?? []);

export const createAccountBindingChallenge = async (
  db: D1Database,
  row: AccountBindingChallengeRow,
): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO auth_account_binding_challenges
        (challenge_id, nonce_hash, user_id, account_id, origin,
         signing_key_fingerprint, issued_at, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      row.challenge_id,
      row.nonce_hash,
      row.user_id,
      row.account_id,
      row.origin,
      row.signing_key_fingerprint,
      row.issued_at,
      row.expires_at,
    )
    .run();
};

export const readAccountBindingChallenge = (
  db: D1Database,
  challengeId: string,
): Promise<AccountBindingChallengeRow | null> =>
  db
    .prepare(
      `SELECT challenge_id, nonce_hash, user_id, account_id, origin,
              signing_key_fingerprint, issued_at, expires_at, consumed_at
       FROM auth_account_binding_challenges
       WHERE challenge_id = ?`,
    )
    .bind(challengeId)
    .first<AccountBindingChallengeRow>();

export const consumeAccountBindingChallenge = (
  db: D1Database,
  challengeId: string,
  consumedAt: number,
): Promise<{ challenge_id: string } | null> =>
  db
    .prepare(
      `UPDATE auth_account_binding_challenges
       SET consumed_at = ?
       WHERE challenge_id = ? AND consumed_at IS NULL AND expires_at > ?
       RETURNING challenge_id`,
    )
    .bind(consumedAt, challengeId, consumedAt)
    .first<{ challenge_id: string }>();

export const insertAccountBinding = async (
  db: D1Database,
  row: AccountBindingRow,
): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO auth_account_bindings
        (account_id, user_id, signing_key_fingerprint, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO NOTHING`,
    )
    .bind(
      row.account_id,
      row.user_id,
      row.signing_key_fingerprint,
      row.created_at,
      row.updated_at,
    )
    .run();
};

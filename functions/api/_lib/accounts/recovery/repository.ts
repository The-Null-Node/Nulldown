import type { D1Database } from "@cloudflare/workers-types";

export interface AccountRecoveryPackageRow {
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

export const readLatestRecoveryPackageForUser = (
  db: D1Database,
  userId: string,
): Promise<AccountRecoveryPackageRow | null> =>
  db
    .prepare(
      `SELECT account_id, user_id, revision, object_key, ciphertext_digest,
              ciphertext_length, metadata_json, created_at, updated_at
       FROM auth_account_recovery_packages
       WHERE user_id = ?
       ORDER BY updated_at DESC, account_id ASC
       LIMIT 1`,
    )
    .bind(userId)
    .first<AccountRecoveryPackageRow>();

export const readRecoveryPackageForAccount = (
  db: D1Database,
  accountId: string,
): Promise<AccountRecoveryPackageRow | null> =>
  db
    .prepare(
      `SELECT account_id, user_id, revision, object_key, ciphertext_digest,
              ciphertext_length, metadata_json, created_at, updated_at
       FROM auth_account_recovery_packages
       WHERE account_id = ?`,
    )
    .bind(accountId)
    .first<AccountRecoveryPackageRow>();

export const advanceRecoveryPackage = async (
  db: D1Database,
  row: AccountRecoveryPackageRow,
  expectedRevision: number,
): Promise<boolean> => {
  if (expectedRevision === 0) {
    await db
      .prepare(
        `INSERT INTO auth_account_recovery_packages
          (account_id, user_id, revision, object_key, ciphertext_digest,
           ciphertext_length, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO NOTHING`,
      )
      .bind(
        row.account_id,
        row.user_id,
        row.revision,
        row.object_key,
        row.ciphertext_digest,
        row.ciphertext_length,
        row.metadata_json,
        row.created_at,
        row.updated_at,
      )
      .run();
  } else {
    await db
      .prepare(
        `UPDATE auth_account_recovery_packages
         SET revision = ?, object_key = ?, ciphertext_digest = ?,
             ciphertext_length = ?, metadata_json = ?, updated_at = ?
         WHERE account_id = ? AND user_id = ? AND revision = ?`,
      )
      .bind(
        row.revision,
        row.object_key,
        row.ciphertext_digest,
        row.ciphertext_length,
        row.metadata_json,
        row.updated_at,
        row.account_id,
        row.user_id,
        expectedRevision,
      )
      .run();
  }

  const persisted = await readRecoveryPackageForAccount(db, row.account_id);
  return (
    persisted?.user_id === row.user_id &&
    persisted.revision === row.revision &&
    persisted.object_key === row.object_key
  );
};

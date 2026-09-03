import type {
  AccountPreferenceField,
  AccountPreferenceValues,
} from "../../../../../shared/auth/accountPreferences";
import type { VoidSqlStore } from "../../../../../src/server/ports";

export interface AccountPreferenceRow {
  preference_key: AccountPreferenceField;
  preference_value: string;
  revision: number;
  updated_at: number;
}

/** Reads the durable preference rows for one OpenAuth user. */
export const listAccountPreferenceRows = async (
  db: VoidSqlStore,
  userId: string,
): Promise<AccountPreferenceRow[]> => {
  const rows = await db
    .prepare(
      `SELECT preference_key, preference_value, revision, updated_at
       FROM auth_user_preferences WHERE user_id = ?`,
    )
    .bind(userId)
    .all<AccountPreferenceRow>();
  return rows.results ?? [];
};

/** Reads one field after a conditional write resolves. */
export const readAccountPreferenceRow = (
  db: VoidSqlStore,
  userId: string,
  field: AccountPreferenceField,
): Promise<AccountPreferenceRow | null> =>
  db
    .prepare(
      `SELECT preference_key, preference_value, revision, updated_at
       FROM auth_user_preferences WHERE user_id = ? AND preference_key = ?`,
    )
    .bind(userId, field)
    .first<AccountPreferenceRow>();

/** Advances exactly one preference when its field-local revision matches. */
export const advanceAccountPreferenceField = async <F extends AccountPreferenceField>(
  db: VoidSqlStore,
  input: {
    userId: string;
    field: F;
    value: AccountPreferenceValues[F];
    expectedRevision: number;
    updatedAt: number;
  },
): Promise<{ applied: boolean; current: AccountPreferenceRow | null }> => {
  await (
    input.expectedRevision === 0
      ? db
          .prepare(
            `INSERT INTO auth_user_preferences
              (user_id, preference_key, preference_value, revision, updated_at)
             VALUES (?, ?, ?, 1, ?)
             ON CONFLICT(user_id, preference_key) DO NOTHING`,
          )
          .bind(input.userId, input.field, input.value, input.updatedAt)
          .run()
      : db
          .prepare(
            `UPDATE auth_user_preferences
             SET preference_value = ?, revision = revision + 1, updated_at = ?
             WHERE user_id = ? AND preference_key = ? AND revision = ?`,
          )
          .bind(
            input.value,
            input.updatedAt,
            input.userId,
            input.field,
            input.expectedRevision,
          )
          .run()
  );

  const current = await readAccountPreferenceRow(db, input.userId, input.field);

  return {
    // The portable SQL port intentionally hides adapter-specific affected-row metadata.
    applied:
      current?.preference_value === input.value &&
      current.revision === input.expectedRevision + 1 &&
      current.updated_at === input.updatedAt,
    current,
  };
};

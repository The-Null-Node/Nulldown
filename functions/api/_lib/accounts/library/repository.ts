import type { VoidSqlStore } from "../../../../../src/server/ports";
import type {
  AccountLibraryEntry,
  AccountLibraryVisibility,
} from "../../../../../shared/auth/accountLibrary";

interface AccountLibraryRow {
  entry_seq: number;
  drop_id: string;
  account_id: string;
  visibility: AccountLibraryVisibility;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface AccountLibraryCursor {
  watermark: number;
  beforeSeq: number;
}

const mapRow = (row: AccountLibraryRow): AccountLibraryEntry =>
  row.deleted_at === null
    ? {
        state: "active",
        id: row.drop_id,
        visibility: row.visibility,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : { state: "deleted", id: row.drop_id, deletedAt: row.deleted_at };

/** Adds or revives the verified ownership projection for a sealed remote drop. */
export const upsertAccountLibraryEntry = async (
  db: VoidSqlStore,
  input: {
    dropId: string;
    accountId: string;
    visibility: AccountLibraryVisibility;
    createdAt: number;
    updatedAt: number;
  },
): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO account_library_entries
        (drop_id, account_id, visibility, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(drop_id) DO UPDATE SET
          visibility = excluded.visibility,
          updated_at = excluded.updated_at,
          deleted_at = NULL
        WHERE account_library_entries.account_id = excluded.account_id`,
    )
    .bind(
      input.dropId,
      input.accountId,
      input.visibility,
      input.createdAt,
      input.updatedAt,
    )
    .run();
};

/** Marks an owned remote drop deleted without losing its convergence identity. */
export const tombstoneAccountLibraryEntry = async (
  db: VoidSqlStore,
  dropId: string,
  deletedAt: number,
): Promise<void> => {
  await db
    .prepare(
      `UPDATE account_library_entries
       SET deleted_at = ?, updated_at = ?
       WHERE drop_id = ? AND deleted_at IS NULL`,
    )
    .bind(deletedAt, deletedAt, dropId)
    .run();
};

/** Reads one trusted account-library projection by canonical drop id. */
export const readAccountLibraryEntry = (
  db: VoidSqlStore,
  dropId: string,
): Promise<AccountLibraryRow | null> =>
  db
    .prepare(
      `SELECT entry_seq, drop_id, account_id, visibility, created_at, updated_at, deleted_at
       FROM account_library_entries WHERE drop_id = ?`,
    )
    .bind(dropId)
    .first<AccountLibraryRow>();

/** Reads stable account-scoped pages using an immutable sequence watermark. */
export const listAccountLibraryEntries = async (
  db: VoidSqlStore,
  accountIds: string[],
  limit: number,
  cursor: AccountLibraryCursor | null,
): Promise<{ items: AccountLibraryEntry[]; cursor: AccountLibraryCursor | null }> => {
  if (!accountIds.length) return { items: [], cursor: null };
  const placeholders = accountIds.map(() => "?").join(", ");
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const watermark = cursor?.watermark ?? Number.MAX_SAFE_INTEGER;
  const beforeSeq = cursor?.beforeSeq ?? Number.MAX_SAFE_INTEGER;
  const rows = await db
    .prepare(
      `SELECT entry_seq, drop_id, account_id, visibility, created_at, updated_at, deleted_at
       FROM account_library_entries
       WHERE account_id IN (${placeholders})
         AND entry_seq <= ? AND entry_seq < ?
       ORDER BY entry_seq DESC
       LIMIT ?`,
    )
    .bind(...accountIds, watermark, beforeSeq, safeLimit + 1)
    .all<AccountLibraryRow>();
  const allRows = rows.results ?? [];
  const pageRows = allRows.slice(0, safeLimit);
  const firstSeq = pageRows[0]?.entry_seq;
  const lastSeq = pageRows.at(-1)?.entry_seq;
  const pageWatermark = cursor?.watermark ?? firstSeq ?? 0;

  return {
    items: pageRows.map(mapRow),
    cursor:
      allRows.length > safeLimit && lastSeq !== undefined
        ? { watermark: pageWatermark, beforeSeq: lastSeq }
        : null,
  };
};

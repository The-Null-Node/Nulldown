import { describe, expect, it, jest } from "@jest/globals";

import {
  listAccountLibraryEntries,
  tombstoneAccountLibraryEntry,
  upsertAccountLibraryEntry,
} from "./repository";

const rows = [
  {
    entry_seq: 12,
    drop_id: "drop_new",
    account_id: "account_a",
    visibility: "private" as const,
    created_at: 1,
    updated_at: 4,
    deleted_at: null,
  },
  {
    entry_seq: 11,
    drop_id: "drop_deleted",
    account_id: "account_a",
    visibility: "unlisted" as const,
    created_at: 2,
    updated_at: 5,
    deleted_at: 6,
  },
  {
    entry_seq: 10,
    drop_id: "drop_later_page",
    account_id: "account_a",
    visibility: "public" as const,
    created_at: 3,
    updated_at: 7,
    deleted_at: null,
  },
];

const createDatabase = () => {
  const bind = jest.fn().mockReturnThis();
  const all = jest.fn().mockResolvedValue({ results: rows });
  const run = jest.fn().mockResolvedValue({ success: true });
  const prepare = jest.fn((sql: string) => {
    void sql;
    return { bind, all, run };
  });
  return { prepare, bind, all, run };
};

describe("account-library repository", () => {
  it("uses an immutable keyset watermark without OFFSET and retains tombstones", async () => {
    const db = createDatabase();

    const page = await listAccountLibraryEntries(
      db as never,
      ["account_a"],
      2,
      null,
    );

    expect(db.prepare.mock.calls[0]?.[0]).toContain(
      "entry_seq <= ? AND entry_seq < ?",
    );
    expect(db.prepare.mock.calls[0]?.[0]).not.toContain("OFFSET");
    expect(db.bind).toHaveBeenCalledWith(
      "account_a",
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      3,
    );
    expect(page.items).toEqual([
      {
        state: "active",
        id: "drop_new",
        visibility: "private",
        createdAt: 1,
        updatedAt: 4,
      },
      { state: "deleted", id: "drop_deleted", deletedAt: 6 },
    ]);
    expect(page.cursor).toEqual({ watermark: 12, beforeSeq: 11 });
  });

  it("preserves original creation time on upsert and writes deletion as a tombstone", async () => {
    const db = createDatabase();

    await upsertAccountLibraryEntry(db as never, {
      dropId: "drop_a",
      accountId: "account_a",
      visibility: "private",
      createdAt: 1,
      updatedAt: 2,
    });
    await tombstoneAccountLibraryEntry(db as never, "drop_a", 3);

    expect(db.prepare.mock.calls[0]?.[0]).not.toContain(
      "created_at = excluded.created_at",
    );
    expect(db.prepare.mock.calls[1]?.[0]).toContain(
      "SET deleted_at = ?, updated_at = ?",
    );
    expect(db.bind).toHaveBeenLastCalledWith(3, 3, "drop_a");
  });

  it("never transfers an existing drop projection to a different account", async () => {
    const db = createDatabase();

    await upsertAccountLibraryEntry(db as never, {
      dropId: "drop_a",
      accountId: "account_b",
      visibility: "private",
      createdAt: 1,
      updatedAt: 2,
    });

    const statement = db.prepare.mock.calls[0]?.[0] as string;
    expect(statement).not.toMatch(
      /DO UPDATE SET\s+account_id = excluded\.account_id/,
    );
    expect(statement).toContain(
      "WHERE account_library_entries.account_id = excluded.account_id",
    );
  });
});

-- Account-scoped remote discovery is a derived projection of verified sealed envelopes.
CREATE TABLE IF NOT EXISTS account_library_entries (
  entry_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  drop_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  visibility TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_account_library_entries_account_seq
  ON account_library_entries(account_id, entry_seq DESC);

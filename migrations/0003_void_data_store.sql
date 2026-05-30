-- Generic VoidDataStore records and query indexes.
-- D1 owns generic data records; R2 is not a fallback for this store.

CREATE TABLE IF NOT EXISTS void_data_records (
  namespace TEXT NOT NULL,
  collection TEXT NOT NULL DEFAULT '',
  scope_key TEXT NOT NULL DEFAULT '',
  id TEXT NOT NULL,
  key_json TEXT NOT NULL,
  record_json TEXT NOT NULL,
  content_type TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(namespace, collection, scope_key, id)
);

CREATE INDEX IF NOT EXISTS idx_void_data_records_list
  ON void_data_records(namespace, collection, scope_key, id);

CREATE INDEX IF NOT EXISTS idx_void_data_records_updated
  ON void_data_records(namespace, collection, updated_at DESC);

CREATE TABLE IF NOT EXISTS void_data_indexes (
  namespace TEXT NOT NULL,
  collection TEXT NOT NULL DEFAULT '',
  scope_key TEXT NOT NULL DEFAULT '',
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'exact',
  value_text TEXT,
  value_number REAL,
  value_bool INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_void_data_indexes_exact_text
  ON void_data_indexes(namespace, collection, name, value_text);

CREATE INDEX IF NOT EXISTS idx_void_data_indexes_exact_number
  ON void_data_indexes(namespace, collection, name, value_number);

CREATE INDEX IF NOT EXISTS idx_void_data_indexes_scope
  ON void_data_indexes(namespace, collection, scope_key, id);

CREATE VIRTUAL TABLE IF NOT EXISTS void_data_fts USING fts5(
  text,
  namespace UNINDEXED,
  collection UNINDEXED,
  scope_key UNINDEXED,
  id UNINDEXED
);

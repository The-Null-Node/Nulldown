-- NullMem stores optional, non-blocking memory facts, procedures, and capabilities.
CREATE TABLE IF NOT EXISTS nullmem_records (
  root_drop_id TEXT NOT NULL DEFAULT '',
  branch_id TEXT NOT NULL DEFAULT '',
  record_kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  target_kind TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  labels_json TEXT NOT NULL DEFAULT '[]',
  priority REAL,
  confidence REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY(root_drop_id, branch_id, record_kind, record_id)
);

CREATE INDEX IF NOT EXISTS idx_nullmem_records_scope
  ON nullmem_records(root_drop_id, branch_id, record_kind, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_nullmem_records_target
  ON nullmem_records(root_drop_id, branch_id, target_kind, target_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_nullmem_records_priority
  ON nullmem_records(root_drop_id, branch_id, priority DESC, created_at DESC);

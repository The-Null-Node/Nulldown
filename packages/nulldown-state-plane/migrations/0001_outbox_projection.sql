CREATE TABLE IF NOT EXISTS state_plane_outbox_delivery_receipts (
  job_ref TEXT NOT NULL,
  key_id TEXT NOT NULL,
  root_drop_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  domain TEXT NOT NULL CHECK (domain IN ('document', 'runtime_fact', 'nullmem')),
  version INTEGER NOT NULL CHECK (version >= 0),
  source_hash TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  archive_key TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  delivered_at INTEGER NOT NULL CHECK (delivered_at >= 0),
  PRIMARY KEY (job_ref, key_id)
);

CREATE INDEX IF NOT EXISTS state_plane_outbox_receipts_branch
  ON state_plane_outbox_delivery_receipts(root_drop_id, branch_id, generation, domain, version);

CREATE TABLE IF NOT EXISTS state_plane_outbox_projection_cursor (
  root_drop_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (domain IN ('document', 'runtime_fact', 'nullmem')),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  version INTEGER NOT NULL CHECK (version >= 0),
  job_ref TEXT NOT NULL,
  key_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  archive_key TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (root_drop_id, branch_id, domain)
);

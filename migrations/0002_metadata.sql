-- D1 metadata store for Nulldown runtime records.
-- R2 remains the blob/checkpoint/archive store; D1 owns queryable metadata and indexes.

CREATE TABLE IF NOT EXISTS drops (
  id TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  etag TEXT,
  short_id TEXT,
  owner_account_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'unlisted',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata_json TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_drops_short_id ON drops(short_id) WHERE short_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_drops_updated_at ON drops(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_drops_owner_updated ON drops(owner_account_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_drops_visibility_updated ON drops(visibility, updated_at DESC);

CREATE TABLE IF NOT EXISTS drop_aliases (
  short_id TEXT PRIMARY KEY,
  full_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_drop_aliases_full_id ON drop_aliases(full_id);

CREATE TABLE IF NOT EXISTS public_drops (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_public_drops_updated ON public_drops(updated_at DESC);

CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  signing_public_jwk TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS branches (
  root_drop_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  base_drop_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  owner_account_id TEXT,
  writer_account_id TEXT,
  writer_client_id TEXT,
  head_snapshot_id INTEGER NOT NULL,
  snapshot_heap_version INTEGER,
  head_event_seq INTEGER,
  checkpoint_interval INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY(root_drop_id, branch_id)
);

CREATE INDEX IF NOT EXISTS idx_branches_root_created ON branches(root_drop_id, created_at);
CREATE INDEX IF NOT EXISTS idx_branches_root_updated ON branches(root_drop_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS branch_writers (
  root_drop_id TEXT NOT NULL,
  writer_key TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(root_drop_id, writer_key)
);

CREATE TABLE IF NOT EXISTS branch_snapshots (
  root_drop_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  snapshot_id INTEGER NOT NULL,
  parent_snapshot_id INTEGER,
  seq INTEGER NOT NULL,
  checkpointed INTEGER NOT NULL,
  patch_start_seq INTEGER,
  patch_end_seq INTEGER,
  checkpoint_key TEXT,
  text_length INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY(root_drop_id, branch_id, snapshot_id)
);

CREATE INDEX IF NOT EXISTS idx_branch_snapshots_branch_created
  ON branch_snapshots(root_drop_id, branch_id, created_at);

CREATE TABLE IF NOT EXISTS branch_events (
  root_drop_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  snapshot_id INTEGER,
  source_client_id TEXT,
  created_at INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY(root_drop_id, branch_id, seq),
  UNIQUE(root_drop_id, branch_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_branch_events_poll
  ON branch_events(root_drop_id, branch_id, seq);

CREATE TABLE IF NOT EXISTS diff_auth_credentials (
  drop_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  kid TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  secret TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  record_json TEXT NOT NULL,
  PRIMARY KEY(drop_id, client_id, kid)
);

CREATE INDEX IF NOT EXISTS idx_diff_auth_credentials_branch
  ON diff_auth_credentials(drop_id, branch_id);

CREATE TABLE IF NOT EXISTS nullplug_facts (
  fact_kind TEXT NOT NULL,
  root_drop_id TEXT NOT NULL,
  branch_id TEXT NOT NULL DEFAULT '',
  call_id TEXT NOT NULL DEFAULT '',
  fact_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  fact_json TEXT NOT NULL,
  PRIMARY KEY(fact_kind, root_drop_id, branch_id, call_id, fact_id)
);

CREATE INDEX IF NOT EXISTS idx_nullplug_facts_scope
  ON nullplug_facts(fact_kind, root_drop_id, branch_id, created_at);

CREATE TABLE IF NOT EXISTS resolved_heaps (
  root_drop_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  snapshot_id INTEGER NOT NULL,
  resolver_id TEXT NOT NULL,
  resolver_version TEXT NOT NULL,
  source_content_hash TEXT NOT NULL,
  resolved_at INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  PRIMARY KEY(root_drop_id, branch_id, snapshot_id, resolver_id)
);

CREATE TABLE IF NOT EXISTS resolved_nodes (
  root_drop_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  snapshot_id INTEGER NOT NULL,
  resolver_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_start INTEGER,
  source_end INTEGER,
  text TEXT NOT NULL,
  importance REAL,
  node_json TEXT NOT NULL,
  PRIMARY KEY(root_drop_id, branch_id, snapshot_id, resolver_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_resolved_nodes_source
  ON resolved_nodes(root_drop_id, branch_id, snapshot_id, resolver_id, source_start);

CREATE INDEX IF NOT EXISTS idx_resolved_nodes_kind
  ON resolved_nodes(root_drop_id, branch_id, snapshot_id, resolver_id, kind, source_start);

CREATE VIRTUAL TABLE IF NOT EXISTS resolved_nodes_fts USING fts5(
  text,
  content='resolved_nodes',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS resolved_nodes_insert AFTER INSERT ON resolved_nodes BEGIN
  INSERT INTO resolved_nodes_fts(rowid, text)
  VALUES (new.rowid, new.text);
END;

CREATE TRIGGER IF NOT EXISTS resolved_nodes_delete AFTER DELETE ON resolved_nodes BEGIN
  INSERT INTO resolved_nodes_fts(resolved_nodes_fts, rowid, text)
  VALUES ('delete', old.rowid, old.text);
END;

CREATE TRIGGER IF NOT EXISTS resolved_nodes_update AFTER UPDATE ON resolved_nodes BEGIN
  INSERT INTO resolved_nodes_fts(resolved_nodes_fts, rowid, text)
  VALUES ('delete', old.rowid, old.text);
  INSERT INTO resolved_nodes_fts(rowid, text)
  VALUES (new.rowid, new.text);
END;

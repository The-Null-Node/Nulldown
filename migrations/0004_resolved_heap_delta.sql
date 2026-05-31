-- Semantic/resolved heap v2 delta records and agent priority facts.
-- The existing resolved_heaps/resolved_nodes tables remain the query projection path.

CREATE TABLE IF NOT EXISTS resolved_heap_deltas (
  root_drop_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  snapshot_id INTEGER NOT NULL,
  resolver_id TEXT NOT NULL,
  resolver_version TEXT NOT NULL,
  parent_snapshot_id INTEGER,
  parent_resolver_id TEXT,
  source_content_hash TEXT NOT NULL,
  source_seq_from INTEGER,
  source_seq_to INTEGER,
  resolved_at INTEGER NOT NULL,
  checkpointed INTEGER NOT NULL DEFAULT 0,
  heap_delta_json TEXT NOT NULL,
  PRIMARY KEY(root_drop_id, branch_id, snapshot_id, resolver_id)
);

CREATE INDEX IF NOT EXISTS idx_resolved_heap_deltas_parent
  ON resolved_heap_deltas(root_drop_id, branch_id, parent_snapshot_id, parent_resolver_id);

CREATE INDEX IF NOT EXISTS idx_resolved_heap_deltas_resolved_at
  ON resolved_heap_deltas(root_drop_id, branch_id, resolver_id, resolved_at DESC);

CREATE TABLE IF NOT EXISTS resolved_node_refs (
  root_drop_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  snapshot_id INTEGER NOT NULL,
  resolver_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  node_hash TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  source_start INTEGER,
  source_end INTEGER,
  parent_node_id TEXT,
  importance REAL,
  ref_json TEXT NOT NULL,
  PRIMARY KEY(root_drop_id, branch_id, snapshot_id, resolver_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_resolved_node_refs_hash
  ON resolved_node_refs(node_hash);

CREATE INDEX IF NOT EXISTS idx_resolved_node_refs_kind
  ON resolved_node_refs(root_drop_id, branch_id, snapshot_id, resolver_id, kind, source_start);

CREATE INDEX IF NOT EXISTS idx_resolved_node_refs_parent
  ON resolved_node_refs(root_drop_id, branch_id, snapshot_id, resolver_id, parent_node_id);

CREATE TABLE IF NOT EXISTS resolved_priority_facts (
  root_drop_id TEXT NOT NULL,
  branch_id TEXT NOT NULL DEFAULT '',
  resolver_id TEXT NOT NULL DEFAULT '',
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  priority REAL NOT NULL,
  created_at INTEGER NOT NULL,
  source_seq INTEGER,
  source_event_id TEXT,
  fact_json TEXT NOT NULL,
  PRIMARY KEY(root_drop_id, branch_id, resolver_id, target_kind, target_id, fact_id)
);

CREATE INDEX IF NOT EXISTS idx_resolved_priority_facts_target
  ON resolved_priority_facts(root_drop_id, branch_id, resolver_id, target_kind, target_id, priority DESC);

CREATE INDEX IF NOT EXISTS idx_resolved_priority_facts_created
  ON resolved_priority_facts(root_drop_id, branch_id, created_at DESC);

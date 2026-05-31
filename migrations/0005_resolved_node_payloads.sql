-- Content-addressed payloads for compact semantic/resolved heap deltas.

CREATE TABLE IF NOT EXISTS resolved_node_payloads (
  node_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  source_start INTEGER,
  source_end INTEGER,
  text TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  node_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_resolved_node_payloads_kind
  ON resolved_node_payloads(kind, source_hash);

CREATE INDEX IF NOT EXISTS idx_resolved_node_payloads_source
  ON resolved_node_payloads(source_hash, source_start, source_end);

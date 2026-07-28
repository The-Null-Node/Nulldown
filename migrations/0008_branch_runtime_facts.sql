CREATE TABLE IF NOT EXISTS branch_runtime_facts (
  root_drop_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  fact_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  fact_json TEXT NOT NULL,
  PRIMARY KEY(root_drop_id, branch_id, seq),
  UNIQUE(root_drop_id, branch_id, fact_id)
);

CREATE INDEX IF NOT EXISTS idx_branch_runtime_facts_poll
  ON branch_runtime_facts(root_drop_id, branch_id, seq);

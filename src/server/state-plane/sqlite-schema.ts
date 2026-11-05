import type { BranchSqlPort } from "./sqlite-port";
import { BranchStateError } from "../../../shared/drop/branch-state";

/** Encodes one logical JavaScript string losslessly before a SQLite UTF-8 TEXT binding. */
export function encodeBranchSqlText(value: string): string {
  return JSON.stringify(value);
}

/** Decodes canonical SQL string storage; malformed, non-string or noncanonical values are corruption, never raw-text fallback. */
export function decodeBranchSqlText(value: unknown): string {
  if (typeof value !== "string") throw new BranchStateError("state_corrupt");
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new BranchStateError("state_corrupt");
  }
  if (typeof decoded !== "string" || encodeBranchSqlText(decoded) !== value) {
    throw new BranchStateError("state_corrupt");
  }
  return decoded;
}

/**
 * Version-one local schema; every lookup/uniqueness constraint is branch scoped.
 * root_drop_id, branch_id and event_id keys, and snapshot content, ALWAYS store
 * JSON.stringify(logicalString). This preserves every UTF-16 code unit, including
 * lone surrogates that raw SQLite UTF-8 TEXT bindings would replace with U+FFFD.
 * Lookups/comparisons encode keys identically; content is decoded and validated
 * before logical length/hash checks or return. Hash columns remain ASCII hashes.
 * *_json records retain their single JSON-object encoding; outbox_id retains its
 * already lossless JSON-tuple encoding. No raw-text fallback, conversion of old
 * local fixtures, migration or projection consumer is supplied by this schema.
 * Runtime fact identity is an exact JSON tuple; public fact_id/fact_key columns
 * use encodeBranchSqlText, intent is canonical JSON, and *_json stores records.
 */
export const BRANCH_SQL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS branch_nullmem_heads (
    root_drop_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    memory_revision INTEGER NOT NULL CHECK (memory_revision > 0),
    PRIMARY KEY (root_drop_id, branch_id)
  )`,
  `CREATE TABLE IF NOT EXISTS branch_nullmem_records (
    root_drop_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    identity TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (root_drop_id, branch_id, identity)
  )`,
  `CREATE TABLE IF NOT EXISTS branch_nullmem_outbox (
    root_drop_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    memory_revision INTEGER NOT NULL CHECK (memory_revision > 0),
    outbox_id TEXT NOT NULL, outbox_json TEXT NOT NULL,
    PRIMARY KEY (root_drop_id, branch_id, memory_revision), UNIQUE (outbox_id)
  )`,
  `CREATE TABLE IF NOT EXISTS branch_runtime_fact_heads (
    root_drop_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    head_seq INTEGER NOT NULL CHECK (head_seq >= 0),
    PRIMARY KEY (root_drop_id, branch_id)
  )`,
  `CREATE TABLE IF NOT EXISTS branch_runtime_facts (
    root_drop_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    identity TEXT NOT NULL, fact_id TEXT NOT NULL, fact_key TEXT NOT NULL,
    seq INTEGER NOT NULL CHECK (seq >= 0), event_json TEXT NOT NULL,
    PRIMARY KEY (root_drop_id, branch_id, identity),
    UNIQUE (root_drop_id, branch_id, fact_id),
    UNIQUE (root_drop_id, branch_id, fact_key),
    UNIQUE (root_drop_id, branch_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS branch_runtime_fact_receipts (
    root_drop_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    identity TEXT NOT NULL, intent TEXT NOT NULL, receipt_json TEXT NOT NULL,
    PRIMARY KEY (root_drop_id, branch_id, identity)
  )`,
  `CREATE TABLE IF NOT EXISTS branch_runtime_fact_outbox (
    root_drop_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    identity TEXT NOT NULL, outbox_id TEXT NOT NULL, outbox_json TEXT NOT NULL,
    PRIMARY KEY (root_drop_id, branch_id, identity), UNIQUE (outbox_id)
  )`,
  `CREATE TABLE IF NOT EXISTS branch_fixture_seeds (
    root_drop_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    PRIMARY KEY (root_drop_id, branch_id)
  )`,
  `CREATE TABLE IF NOT EXISTS branch_authorities (
    root_drop_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    authority_json TEXT NOT NULL,
    initialization_intent TEXT,
    initialization_receipt_json TEXT,
    PRIMARY KEY (root_drop_id, branch_id)
  )`,
  `CREATE TABLE IF NOT EXISTS branch_heads (
    root_drop_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    routing_version INTEGER NOT NULL CHECK (routing_version = 1),
    generation INTEGER NOT NULL CHECK (generation >= 0),
    head_json TEXT NOT NULL,
    PRIMARY KEY (root_drop_id, branch_id)
  )`,
  `CREATE TABLE IF NOT EXISTS branch_snapshots (
    root_drop_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    snapshot_id INTEGER NOT NULL CHECK (snapshot_id >= 0),
    event_seq INTEGER NOT NULL CHECK (event_seq >= -1),
    source_content_hash TEXT NOT NULL, content TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    PRIMARY KEY (root_drop_id, branch_id, snapshot_id)
  )`,
  `CREATE TABLE IF NOT EXISTS branch_events (
    root_drop_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    event_seq INTEGER NOT NULL CHECK (event_seq >= 0),
    event_id TEXT NOT NULL, snapshot_id INTEGER NOT NULL,
    event_json TEXT NOT NULL,
    PRIMARY KEY (root_drop_id, branch_id, event_seq),
    UNIQUE (root_drop_id, branch_id, event_id)
  )`,
  `CREATE TABLE IF NOT EXISTS branch_receipts (
    root_drop_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    event_id TEXT NOT NULL, payload_hash TEXT NOT NULL, receipt_json TEXT NOT NULL,
    PRIMARY KEY (root_drop_id, branch_id, event_id)
  )`,
  `CREATE TABLE IF NOT EXISTS branch_outbox (
    root_drop_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    event_id TEXT NOT NULL, outbox_id TEXT NOT NULL, outbox_json TEXT NOT NULL,
    PRIMARY KEY (root_drop_id, branch_id, event_id),
    UNIQUE (outbox_id)
  )`,
  `CREATE TABLE IF NOT EXISTS branch_outbox_delivery (
    outbox_id TEXT PRIMARY KEY, kind TEXT NOT NULL, root_drop_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation >= 0), status TEXT NOT NULL CHECK (status IN ('pending','claimed','completed','fenced')),
    attempts INTEGER NOT NULL CHECK (attempts >= 0), next_attempt_at INTEGER NOT NULL DEFAULT 0,
    lease_id TEXT, lease_token TEXT, lease_until INTEGER, completed_at INTEGER, last_error_code TEXT,
    CHECK ((status = 'claimed' AND lease_id IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL AND next_attempt_at = lease_until) OR status != 'claimed')
  )`,
  `CREATE TABLE IF NOT EXISTS branch_outbox_delivery_bootstrap (
    source TEXT PRIMARY KEY CHECK (source IN ('diff','runtime','nullmem')),
    rowid_cursor INTEGER NOT NULL DEFAULT 0 CHECK (rowid_cursor >= 0),
    complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0,1))
  )`,
  `CREATE TABLE IF NOT EXISTS branch_migrations (
    migration_id TEXT PRIMARY KEY, root_drop_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation >= 0), phase TEXT NOT NULL CHECK (phase IN ('importing','verified','activated','rollback-pending','rolled-back','recovery-required')),
    manifest_json TEXT NOT NULL, next_chunk INTEGER NOT NULL DEFAULT 0 CHECK (next_chunk >= 0),
    item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0), payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK(payload_bytes BETWEEN 0 AND 8000000)
  )`,
  `CREATE INDEX IF NOT EXISTS branch_migrations_by_target_phase ON branch_migrations(root_drop_id,branch_id,phase,migration_id)`,
  `CREATE TABLE IF NOT EXISTS branch_migration_chunks (
    migration_id TEXT NOT NULL, chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL, charged_bytes INTEGER NOT NULL CHECK(charged_bytes BETWEEN 1 AND 1000000),
    PRIMARY KEY (migration_id, chunk_index), FOREIGN KEY (migration_id) REFERENCES branch_migrations(migration_id)
  )`,
  `CREATE TABLE IF NOT EXISTS branch_migration_public_acks (
    migration_id TEXT NOT NULL, event_id TEXT NOT NULL, acknowledgement_json TEXT NOT NULL,
    provenance TEXT NOT NULL, PRIMARY KEY(migration_id,event_id)
  )`,
  `CREATE TABLE IF NOT EXISTS branch_migration_snapshot_provenance (
    migration_id TEXT NOT NULL, snapshot_id INTEGER NOT NULL, source_snapshot_json TEXT NOT NULL,
    source_content_hash TEXT NOT NULL, PRIMARY KEY(migration_id,snapshot_id)
  )`,
  `CREATE INDEX IF NOT EXISTS branch_migration_snapshot_provenance_by_snapshot ON branch_migration_snapshot_provenance(snapshot_id,migration_id)`,
  `CREATE TABLE IF NOT EXISTS branch_migration_event_provenance (
    migration_id TEXT NOT NULL, event_id TEXT NOT NULL, source_event_json TEXT NOT NULL,
    snapshot_id INTEGER NOT NULL, PRIMARY KEY(migration_id,event_id)
  )`,
  `CREATE INDEX IF NOT EXISTS branch_migration_event_provenance_by_event ON branch_migration_event_provenance(event_id,snapshot_id,migration_id)`,
  `CREATE TABLE IF NOT EXISTS branch_migration_branch_provenance (
    migration_id TEXT NOT NULL, root_drop_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    source_branch_json TEXT NOT NULL, PRIMARY KEY(root_drop_id,branch_id)
  )`,
  `CREATE TABLE IF NOT EXISTS branch_imported_outbox (
    outbox_id TEXT PRIMARY KEY, migration_id TEXT NOT NULL, source_kind TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS branch_runtime_fact_imports (
    root_drop_id TEXT NOT NULL, branch_id TEXT NOT NULL, identity TEXT NOT NULL,
    migration_id TEXT NOT NULL, source_seq INTEGER NOT NULL, source_event_json TEXT NOT NULL,
    PRIMARY KEY(root_drop_id,branch_id,identity)
  )`,
  `CREATE TABLE IF NOT EXISTS branch_nullmem_import_baseline (
    root_drop_id TEXT NOT NULL, branch_id TEXT NOT NULL, migration_id TEXT NOT NULL,
    memory_revision INTEGER NOT NULL CHECK(memory_revision >= 0), source_hash TEXT NOT NULL, records_json TEXT NOT NULL,
    PRIMARY KEY(root_drop_id,branch_id)
  )`,
  `CREATE INDEX IF NOT EXISTS branch_outbox_delivery_active_due ON branch_outbox_delivery(next_attempt_at, outbox_id) WHERE status IN ('pending','claimed')`,
  `CREATE INDEX IF NOT EXISTS branch_outbox_delivery_completed ON branch_outbox_delivery(status, completed_at, outbox_id)`,
] as const;

/** Initializes only tables on a connection; never creates branch state on reads. */
export function initializeBranchSqlSchema(sql: BranchSqlPort): void {
  sql.transaction(() => {
    for (const statement of BRANCH_SQL_SCHEMA) sql.execute(statement);
  });
}

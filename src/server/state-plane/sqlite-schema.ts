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
 */
export const BRANCH_SQL_SCHEMA = [
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
] as const;

/** Initializes only tables on a connection; never creates branch state on reads. */
export function initializeBranchSqlSchema(sql: BranchSqlPort): void {
  sql.transaction(() => {
    for (const statement of BRANCH_SQL_SCHEMA) sql.execute(statement);
  });
}

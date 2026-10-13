import { nullMemRecordText } from "../../../shared/nullmem/capsule";
import type { NullMemRecord } from "../../../shared/nullmem/records";
import { isNullMemRecord } from "../../../shared/nullmem/validation";
import type { SqlMetadataStore } from "../ports";
import type { DeleteStore, QueryStore, WriteStore } from "./capabilities";

/** Branch selection used for one query against a bound NullMem record store. */
export interface NullMemRecordQuery {
  rootDropId: string;
  branchId: string;
  kind?: NullMemRecord["kind"];
  limit?: number;
}

/** Branch-local identity used for one deletion across NullMem record kinds. */
export interface NullMemRecordKey {
  rootDropId: string;
  branchId: string;
  recordId: string;
}

/** NullMem persistence capabilities bound to one adapter for its runtime lifetime. */
export interface NullMemRecordStore
  extends
    QueryStore<NullMemRecordQuery, NullMemRecord>,
    WriteStore<NullMemRecord>,
    DeleteStore<NullMemRecordKey> {}

const readRecord = (value: unknown): NullMemRecord | null => {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    // Keep the original value: parsing the schema would strip historical extras.
    return isNullMemRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * Binds SQL persistence to NullMem records for the composed repository lifetime.
 * Reads validate unknown JSON with the existing historical record guard, skipping
 * invalid rows after SQL applies its limit. Writes retain the caller's record.
 * This adapter exposes only query, write, and delete; no transaction is implied.
 */
export const createSqlNullMemRecordStore = (
  sql: SqlMetadataStore,
): NullMemRecordStore => ({
  async query({ rootDropId, branchId, kind, limit = 250 }) {
    const conditions = [
      "((root_drop_id = '' AND branch_id = '') OR (root_drop_id = ? AND branch_id = ?))",
    ];
    const bindings: (string | number)[] = [rootDropId, branchId];
    if (kind) {
      conditions.push("record_kind = ?");
      bindings.push(kind);
    }
    bindings.push(Math.max(1, Math.min(500, Math.floor(limit))));

    const { results = [] } = await sql
      .prepare(
        `SELECT record_json
       FROM nullmem_records
       WHERE ${conditions.join(" AND ")}
       ORDER BY COALESCE(priority, 0) DESC, created_at DESC
       LIMIT ?`,
      )
      .bind(...bindings)
      .all();

    return results
      .map((row) => readRecord(row.record_json))
      .filter((record): record is NullMemRecord => record !== null);
  },

  async put(record) {
    const rootDropId = "rootDropId" in record ? (record.rootDropId ?? "") : "";
    const branchId = "branchId" in record ? (record.branchId ?? "") : "";
    const targetKind =
      record.kind === "fact"
        ? (record.targetKind ?? "")
        : record.kind === "capability"
          ? record.capabilityKind
          : "procedure";
    const targetId =
      record.kind === "fact"
        ? (record.targetId ?? "")
        : record.kind === "capability"
          ? record.capabilityId
          : record.recordId;
    const createdAt = record.createdAt;
    const updatedAt = record.updatedAt ?? createdAt;

    await sql
      .prepare(
        `INSERT INTO nullmem_records (
         root_drop_id, branch_id, record_kind, record_id, target_kind, target_id,
         text, labels_json, priority, confidence, created_at, updated_at, record_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(root_drop_id, branch_id, record_kind, record_id)
       DO UPDATE SET
         target_kind = excluded.target_kind,
         target_id = excluded.target_id,
         text = excluded.text,
         labels_json = excluded.labels_json,
         priority = excluded.priority,
         confidence = excluded.confidence,
         updated_at = excluded.updated_at,
         record_json = excluded.record_json`,
      )
      .bind(
        rootDropId,
        branchId,
        record.kind,
        record.recordId,
        targetKind,
        targetId,
        nullMemRecordText(record),
        JSON.stringify(record.labels ?? []),
        record.priority ?? null,
        record.confidence ?? null,
        createdAt,
        updatedAt,
        JSON.stringify(record),
      )
      .run();
  },

  async delete({ rootDropId, branchId, recordId }) {
    await sql
      .prepare(
        `DELETE FROM nullmem_records
       WHERE root_drop_id = ? AND branch_id = ? AND record_id = ?`,
      )
      .bind(rootDropId, branchId, recordId)
      .run();
  },
});

import { parseJsonColumn } from "../core/d1/metadata";
import { nullMemRecordText } from "../../../../shared/nullmem/capsule";
import { isNullMemRecord } from "../../../../shared/nullmem/schemas";
import type { NullMemRecord } from "../../../../shared/nullmem/types";
import type { VoidSqlStore } from "../../../../src/server/ports";

/** Ports used by the branch-scoped NullMem repository. */
export interface NullMemRepositoryPorts {
  /** SQL metadata store containing persisted memory records. */
  sql?: VoidSqlStore;
}

/** Repository for persisted branch-scoped NullMem records. */
export interface NullMemRepository {
  /** Reads persisted records for global defaults and one branch. */
  readRecords(
    rootDropId: string,
    branchId: string,
    options?: { kind?: NullMemRecord["kind"]; limit?: number },
  ): Promise<NullMemRecord[]>;
  /** Inserts or replaces one persisted memory record. */
  writeRecord(record: NullMemRecord): Promise<void>;
  /** Deletes one persisted memory record by branch and record id. */
  deleteRecord(
    rootDropId: string,
    branchId: string,
    recordId: string,
  ): Promise<void>;
}

const recordLabels = (record: NullMemRecord): string[] => record.labels ?? [];

const writeNullMemRecordToD1 = async (
  db: VoidSqlStore,
  record: NullMemRecord,
): Promise<void> => {
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

  await db
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
      JSON.stringify(recordLabels(record)),
      record.priority ?? null,
      record.confidence ?? null,
      createdAt,
      updatedAt,
      JSON.stringify(record),
    )
    .run();
};

const deleteNullMemRecordFromD1 = async (
  db: VoidSqlStore,
  rootDropId: string,
  branchId: string,
  recordId: string,
): Promise<void> => {
  await db
    .prepare(
      `DELETE FROM nullmem_records
       WHERE root_drop_id = ? AND branch_id = ? AND record_id = ?`,
    )
    .bind(rootDropId, branchId, recordId)
    .run();
};

const readNullMemRecordsFromD1 = async (
  db: VoidSqlStore,
  rootDropId: string,
  branchId: string,
  kind?: NullMemRecord["kind"],
  limit = 250,
): Promise<NullMemRecord[]> => {
  const conditions = [
    "((root_drop_id = '' AND branch_id = '') OR (root_drop_id = ? AND branch_id = ?))",
  ];
  const bindings: (string | number)[] = [rootDropId, branchId];
  if (kind) {
    conditions.push("record_kind = ?");
    bindings.push(kind);
  }
  bindings.push(Math.max(1, Math.min(500, Math.floor(limit))));

  const { results = [] } = await db
    .prepare(
      `SELECT record_json
       FROM nullmem_records
       WHERE ${conditions.join(" AND ")}
       ORDER BY COALESCE(priority, 0) DESC, created_at DESC
       LIMIT ?`,
    )
    .bind(...bindings)
    .all<{ record_json: string }>();

  return results
    .map((row) => parseJsonColumn(row.record_json, isNullMemRecord))
    .filter((record): record is NullMemRecord => record !== null);
};

/** Creates a NullMem repository bound to composed SQL ports. */
export const createNullMemRepository = ({
  sql,
}: NullMemRepositoryPorts): NullMemRepository => {
  const requireSql = (): VoidSqlStore => {
    if (!sql) {
      throw new Error("SQL metadata store is required to use memory.");
    }
    return sql;
  };

  return {
    readRecords: (rootDropId, branchId, options = {}) =>
      readNullMemRecordsFromD1(
        requireSql(),
        rootDropId,
        branchId,
        options.kind,
        options.limit,
      ),
    writeRecord: (record) => writeNullMemRecordToD1(requireSql(), record),
    deleteRecord: (rootDropId, branchId, recordId) =>
      deleteNullMemRecordFromD1(requireSql(), rootDropId, branchId, recordId),
  };
};

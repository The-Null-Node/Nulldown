import type { NullMemRecord } from "../../../../shared/nullmem/records";
import type { SqlMetadataStore } from "../../../../src/server/ports";
import { createSqlNullMemRecordStore } from "../../../../src/server/stores/nullmem-record-store";

/** Ports used by the branch-scoped NullMem repository. */
export interface NullMemRepositoryPorts {
  /** SQL metadata store containing persisted memory records. */
  sql?: SqlMetadataStore;
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

/** Creates a NullMem repository with record capabilities bound for its lifetime. */
export const createNullMemRepository = ({
  sql,
}: NullMemRepositoryPorts): NullMemRepository => {
  const store = sql ? createSqlNullMemRecordStore(sql) : undefined;
  const requireStore = () => {
    if (!store) {
      throw new Error("SQL metadata store is required to use memory.");
    }
    return store;
  };

  return {
    readRecords: (rootDropId, branchId, options = {}) =>
      requireStore().query({
        rootDropId,
        branchId,
        kind: options.kind,
        limit: options.limit,
      }),
    writeRecord: (record) => requireStore().put(record),
    deleteRecord: (rootDropId, branchId, recordId) =>
      requireStore().delete({ rootDropId, branchId, recordId }),
  };
};

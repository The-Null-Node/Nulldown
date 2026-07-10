import type { ResolvedPriorityFactRecord } from "../../../../../shared/drop/resolved/types";
import type { ResolvedNulldownState } from "../../../../../shared/drop/resolved/types";
import type { VoidSqlStore } from "../../../../../src/server/ports";
import {
  deleteBranchResolvedPriorityFactFromD1,
  listBranchResolvedPriorityFactsFromD1,
  readBranchResolvedPriorityFactFromD1,
  readResolvedPriorityScoring,
  writeResolvedPriorityFactToD1,
} from "./priorityFactsRepository";
import type {
  ResolvedPriorityFactListOptions,
  ResolvedPriorityScoring,
} from "./priorityFactsRepository";
import { createResolvedHeapProjectionRepository } from "./projectionRepository";

/** Ports used by resolved heap repositories. */
export interface ResolvedHeapRepositoryPorts {
  /** Optional SQL metadata store containing resolved heap projections. */
  sql?: VoidSqlStore;
}

/** Repository facade for compact resolved heap projections and priority facts. */
export interface ResolvedHeapRepository {
  /** Reads a resolved heap state from compact D1 projections when available. */
  readState(
    rootDropId: string,
    branchId: string,
    resolverId: string,
    snapshotId: number,
  ): Promise<ResolvedNulldownState | null>;
  /** Synchronizes one resolved heap state into compact D1 projection rows. */
  syncState(state: ResolvedNulldownState): Promise<void>;
  /** Reads priority overlays for one resolved heap query. */
  readPriorityScoring(
    rootDropId: string,
    branchId: string,
    resolverId: string,
  ): Promise<ResolvedPriorityScoring>;
  /** Inserts or updates one branch-scoped resolved priority fact. */
  writePriorityFact(fact: ResolvedPriorityFactRecord): Promise<void>;
  /** Lists branch-scoped resolved priority facts. */
  listBranchPriorityFacts(
    rootDropId: string,
    branchId: string,
    options?: ResolvedPriorityFactListOptions,
  ): Promise<ResolvedPriorityFactRecord[]>;
  /** Reads one branch-scoped resolved priority fact by id. */
  readBranchPriorityFact(
    rootDropId: string,
    branchId: string,
    factId: string,
  ): Promise<ResolvedPriorityFactRecord | null>;
  /** Deletes one branch-scoped resolved priority fact by id. */
  deleteBranchPriorityFact(
    rootDropId: string,
    branchId: string,
    factId: string,
  ): Promise<void>;
}

/** Creates a resolved heap repository bound to composed SQL ports. */
export const createResolvedHeapRepository = ({
  sql,
}: ResolvedHeapRepositoryPorts): ResolvedHeapRepository => {
  const projectionRepository = createResolvedHeapProjectionRepository({ sql });
  const requireSql = (): VoidSqlStore => {
    if (!sql) {
      throw new Error("SQL metadata store is required to use resolved heaps.");
    }
    return sql;
  };

  return {
    readState: projectionRepository.readState,
    syncState: projectionRepository.syncState,
    readPriorityScoring: (rootDropId, branchId, resolverId) =>
      readResolvedPriorityScoring(sql, rootDropId, branchId, resolverId),
    writePriorityFact: (fact) =>
      writeResolvedPriorityFactToD1(requireSql(), fact),
    listBranchPriorityFacts: (rootDropId, branchId, options) =>
      listBranchResolvedPriorityFactsFromD1(
        requireSql(),
        rootDropId,
        branchId,
        options,
      ),
    readBranchPriorityFact: (rootDropId, branchId, factId) =>
      readBranchResolvedPriorityFactFromD1(
        requireSql(),
        rootDropId,
        branchId,
        factId,
      ),
    deleteBranchPriorityFact: (rootDropId, branchId, factId) =>
      deleteBranchResolvedPriorityFactFromD1(
        requireSql(),
        rootDropId,
        branchId,
        factId,
      ),
  };
};

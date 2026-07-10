import { createBranchRepository } from "../branches/storage/repository";
import { evaluateNullMemFreshnessBatch } from "../../../../shared/nullmem/freshness";
import type {
  NullMemFreshnessReport,
  NullMemRecord,
} from "../../../../shared/nullmem/types";
import { readNullMemFreshnessWatermark } from "../../../../src/server/nulledit";
import type {
  VoidBlobStore,
  VoidDataStore,
  VoidSqlStore,
} from "../../../../src/server/ports";

/** Ports used by the branch-scoped NullMem freshness evaluator. */
export interface NullMemFreshnessServicePorts {
  /** Blob store used to read the canonical branch when no derived watermark exists. */
  blobs: VoidBlobStore;
  /** SQL metadata store used by the branch repository fallback. */
  sql?: VoidSqlStore;
  /** Data store containing optional derived freshness watermarks. */
  data?: VoidDataStore;
}

/** Request for evaluating freshness reports for queried memory records. */
export interface NullMemFreshnessEvaluationRequest {
  /** Canonical root drop id whose branch memory was queried. */
  rootDropId: string;
  /** Branch id whose memory was queried. */
  branchId: string;
  /** Records returned by the memory query. */
  records: NullMemRecord[];
  /** Optional caller-provided branch head snapshot id. */
  currentSnapshotId?: number;
}

/** Evaluates freshness for NullMem records against the current branch head. */
export interface NullMemFreshnessService {
  /** Computes freshness reports for queried memory records. */
  evaluate(
    request: NullMemFreshnessEvaluationRequest,
  ): Promise<NullMemFreshnessReport[]>;
}

const resolveFreshnessHeadSnapshotId = async ({
  blobs,
  sql,
  data,
  rootDropId,
  branchId,
  currentSnapshotId,
}: NullMemFreshnessServicePorts & {
  rootDropId: string;
  branchId: string;
  currentSnapshotId?: number;
}): Promise<number | undefined> => {
  if (typeof currentSnapshotId === "number") return currentSnapshotId;

  if (data) {
    try {
      const watermark = await readNullMemFreshnessWatermark(
        data,
        rootDropId,
        branchId,
      );
      if (watermark) return watermark.headSnapshotId;
    } catch {
      // The watermark is derived cache state; fall back to the canonical branch.
    }
  }

  const branchRepository = createBranchRepository({ blobs, sql });
  const branch = await branchRepository.readBranch(rootDropId, branchId);
  return branch?.headSnapshotId;
};

/** Creates the branch-scoped NullMem freshness evaluator. */
export const createNullMemFreshnessService = ({
  blobs,
  sql,
  data,
}: NullMemFreshnessServicePorts): NullMemFreshnessService => ({
  evaluate: async ({ rootDropId, branchId, records, currentSnapshotId }) => {
    const headSnapshotId = await resolveFreshnessHeadSnapshotId({
      blobs,
      sql,
      data,
      rootDropId,
      branchId,
      currentSnapshotId,
    });
    const result = evaluateNullMemFreshnessBatch({
      records,
      currentSnapshotId: headSnapshotId,
    });
    return result.reports;
  },
});

import {
  readBranchContent,
  readBranchEventsBySeqRange,
} from "../../../functions/api/_lib/branches/content/replay";
import {
  backfillBranchToSnapshotHeap,
  resolveBranchForActor,
} from "../../../functions/api/_lib/branches/lifecycle";
import { createBranchRepository } from "../../../functions/api/_lib/branches/storage/repository";
import type { BlobObjectStore, SqlMetadataStore } from "../ports";
import type { BranchStatePlane } from "./contracts";
import { createLegacyBranchDiffPolling } from "./legacy-diffs";
import {
  unobserved,
  type Timing,
} from "../../../functions/api/_lib/core/observability/profiling";

/** Existing platform ports retained for the lifetime of a legacy request adapter. */
export interface LegacyBranchStatePlaneOptions {
  /** Existing blob port; the adapter does not introduce a new persistence format. */
  blobs: BlobObjectStore;
  /** Optional metadata projection, preserving blob-only fallback behavior. */
  sql?: SqlMetadataStore;
  /** Existing escrow credential used only by actor branch initialization. */
  providerPrivateKey?: string;
  /** Optional request-owned observer; omitted preserves the unobserved adapter. */
  timing?: Timing;
}

/** Adapts existing branch services for one request without adding transaction guarantees. */
export const createLegacyBranchStatePlane = ({
  blobs,
  sql,
  providerPrivateKey,
  timing = unobserved,
}: LegacyBranchStatePlaneOptions): BranchStatePlane => {
  const repository = createBranchRepository({ blobs, sql });
  return {
    diffs: createLegacyBranchDiffPolling(blobs, sql),
    branches: {
      readBranch: (rootDropId, branchId) =>
        repository.readBranch(rootDropId, branchId),
      listBranchesForRoot: (rootDropId) =>
        repository.listBranchesForRoot(rootDropId),
      resolveForActor: (rootDropId, accountId, clientId) =>
        resolveBranchForActor(
          blobs,
          rootDropId,
          accountId,
          clientId,
          providerPrivateKey,
          sql,
        ),
    },
    snapshots: {
      readEventsBySeqRange: (rootDropId, branchId, startSeq, endSeq) =>
        readBranchEventsBySeqRange(
          blobs,
          rootDropId,
          branchId,
          startSeq,
          endSeq,
          sql,
        ),
      readSnapshot: (rootDropId, branchId, snapshotId) =>
        repository.readSnapshot(rootDropId, branchId, snapshotId),
      listSnapshotsForBranch: (rootDropId, branchId) =>
        repository.listSnapshotsForBranch(rootDropId, branchId),
      readContent: (rootDropId, branchId, snapshotId) =>
        readBranchContent(blobs, rootDropId, branchId, snapshotId, sql, timing),
    },
    maintenance: {
      listBranchesForRootPage: (rootDropId, limit, cursor) =>
        repository.listBranchesForRootPage(rootDropId, limit, cursor),
      backfillSnapshotHeap: (rootDropId, branchId) =>
        backfillBranchToSnapshotHeap(blobs, rootDropId, branchId, sql),
    },
  };
};

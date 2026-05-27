/*
Branch state is persisted in R2 as branch records, snapshots, checkpoints, and per-event
objects. Focused branch services own lifecycle, append, content, repository, and diff-log
behavior; this module remains as a compatibility facade for existing route/test imports.
*/

export {
  appendEventsToBranch,
  type BranchAppendObserver,
  type BranchAppendObserverContext,
  type BranchAppendObserverOptions,
  type BranchAppendResult,
} from "./branchAppendService";

export {
  readBranchContent,
  readBranchEventsBySeqRange,
} from "./branchContent";

export {
  pollBranchDiffEventsSince,
  readBranchDiffLog,
  readBranchHeadEventSeq,
} from "./branchDiffLogRepository";

export {
  backfillBranchToSnapshotHeapV2,
  ensureBranchHeapV2,
  getOwnerAccountIdForDrop,
  readRootDropState,
  resolveBranchForActor,
  type RootDropState,
} from "./branchLifecycleService";

export {
  listBranchesForRoot,
  listBranchesForRootPage,
  listSnapshotsForBranch,
  readBranch,
  readSnapshot,
} from "./branchRepository";

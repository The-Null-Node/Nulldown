import { createDropDiffRef } from "../../../shared/drop/diff";
import type {
  BranchAcceptedCommit,
  BranchCommitBufferSnapshotterFlushOptions,
  BranchCommitSnapshotterDispatchOptions,
  BranchCommitFlushResult,
  NulleditSnapshotContext,
  NulleditSnapshotter,
  NulleditSnapshotterDispatchOptions,
  NulleditSnapshotterPhase,
} from "./types";
import type { VoidDataStore } from "../ports";

const PHASE_ORDER: Record<NulleditSnapshotterPhase, number> = {
  primary: 0,
  secondary: 1,
  extended: 2,
};

const SNAPSHOTTER_PHASES: NulleditSnapshotterPhase[] = [
  "primary",
  "secondary",
  "extended",
];

const sortSnapshotters = (
  snapshotters: NulleditSnapshotter[],
): NulleditSnapshotter[] =>
  [...snapshotters].sort(
    (left, right) =>
      PHASE_ORDER[left.phase ?? "extended"] -
      PHASE_ORDER[right.phase ?? "extended"],
  );

/** Creates the snapshotter context represented by an accepted branch commit. */
export const createNulleditSnapshotContextForCommit = (
  commit: BranchAcceptedCommit,
  data: VoidDataStore,
): NulleditSnapshotContext => ({
  data,
  rootDropId: commit.rootDropId,
  branchId: commit.branchId,
  snapshotId: commit.snapshotId,
  parentSnapshotId: commit.parentSnapshotId,
  branch: commit.branch,
  snapshot: commit.snapshot,
  frame: { content: commit.content },
  acceptedEvents: commit.acceptedEvents,
  acceptedDiffRefs: commit.acceptedEvents.map((event) =>
    createDropDiffRef({
      rootDropId: commit.rootDropId,
      branchId: commit.branchId,
      seq: event.seq,
      eventId: event.eventId,
      snapshotId: event.snapshotId,
    }),
  ),
  deduplicatedCount: commit.deduplicatedCount,
  totalStored: commit.totalStored,
});

const runNulleditSnapshotters = async (
  context: NulleditSnapshotContext,
  options?: NulleditSnapshotterDispatchOptions,
): Promise<void> => {
  const snapshotters = sortSnapshotters(options?.snapshotters ?? []);
  if (!snapshotters.length) {
    return;
  }

  for (const phase of SNAPSHOTTER_PHASES) {
    const phaseSnapshotters = snapshotters.filter(
      (snapshotter) => (snapshotter.phase ?? "extended") === phase,
    );
    await Promise.all(
      phaseSnapshotters.map(async (snapshotter) => {
        try {
          await snapshotter.snapshot(context);
        } catch (error) {
          options?.onSnapshotterError?.(error, snapshotter.id);
        }
      }),
    );
  }
};

/** Dispatches snapshotters for one accepted branch commit. */
export const dispatchNulleditSnapshottersForCommit = (
  commit: BranchAcceptedCommit,
  options: BranchCommitSnapshotterDispatchOptions,
): void => {
  dispatchNulleditSnapshotters(
    createNulleditSnapshotContextForCommit(commit, options.data),
    options,
  );
};

/** Flushes buffered commits and materializes their derived snapshotter records. */
export const flushBranchCommitBufferSnapshotters = async ({
  commitBuffer,
  rootDropId,
  branchId,
  reason,
  data,
  ...options
}: BranchCommitBufferSnapshotterFlushOptions): Promise<BranchCommitFlushResult> => {
  const result = commitBuffer.flush
    ? await commitBuffer.flush({ rootDropId, branchId, reason })
    : {
        rootDropId,
        branchId,
        reason,
        commits: [],
        bufferedEventCount: 0,
        bufferedByteCount: 0,
        latestSnapshotId: null,
      };

  for (const commit of result.commits) {
    await runNulleditSnapshotters(
      createNulleditSnapshotContextForCommit(commit, data),
      options,
    );
  }

  return result;
};

/** Dispatches Nulledit snapshotters after a snapshot commit without blocking callers. */
export const dispatchNulleditSnapshotters = (
  context: NulleditSnapshotContext,
  options?: NulleditSnapshotterDispatchOptions,
): void => {
  if (!options?.snapshotters?.length) {
    return;
  }

  const task = runNulleditSnapshotters(context, options);

  if (options?.waitUntil) {
    try {
      options.waitUntil(task);
      return;
    } catch (error) {
      options.onSnapshotterError?.(error, "waitUntil");
    }
  }

  void task;
};

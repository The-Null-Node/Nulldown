import type {
  DropBranchRecord,
  DropSnapshotRecord,
} from "../../../../shared/drop/branch";
import { createDropDiffRef, type DropDiffEvent } from "../../../../shared/drop/diff";
import type {
  VoidBlobStore,
  VoidDataKey,
  VoidDataListQuery,
  VoidDataPutOptions,
  VoidDataQuery,
  VoidDataStore,
  VoidSqlStore,
} from "../../../../src/server/ports";
import {
  dispatchNulleditSnapshotters,
  type NulleditSnapshotter,
  type NulleditSnapshotterDispatchOptions,
} from "../../../../src/server/nulledit";
import {
  DEFAULT_CHECKPOINT_INTERVAL,
  createBranchDiffEventIdKey,
} from "../branches/storage/keys";
import { applyBranchDiffEvents, readBranchContent } from "../branches/content/replay";
import { ensureBranchHeapV2 } from "../branches/lifecycle/service";
import { withBranchMutationLock } from "../branches/storage/mutationLock";
import {
  hasBranchDiffEventId,
  writeBranchDiffEvent,
} from "../branches/storage/diffLogRepository";
import {
  readBranch,
  resolveSnapshotCheckpointKey,
  writeBranch,
  writeSnapshot,
  writeSnapshotCheckpoint,
} from "../branches/storage/repository";

/** Options controlling Nulledit snapshotter dispatch for a branch append operation. */
export interface BranchAppendOptions extends NulleditSnapshotterDispatchOptions {
  /** Functional datastore used by snapshotters; Cloudflare bindings are adapted when omitted. */
  data?: VoidDataStore;
  /** Snapshotters fired after diff events are accepted and snapshotted. */
  snapshotters?: NulleditSnapshotter[];
}

/** Result returned after appending and snapshotting accepted branch diff events. */
export interface BranchAppendResult {
  branch: DropBranchRecord;
  snapshot: DropSnapshotRecord | null;
  content: string;
  acceptedEvents: DropDiffEvent[];
  deduplicatedCount: number;
  totalStored: number;
}

const unavailableDataStore = (): VoidDataStore => {
  const fail = (): never => {
    throw new Error("void_data_store_required");
  };
  return {
    get: async <T = unknown>(_key: VoidDataKey): Promise<T | null> => fail(),
    put: async <T = unknown>(
      _key: VoidDataKey,
      _value: T,
      _options?: VoidDataPutOptions,
    ): Promise<void> => fail(),
    delete: async (_key: VoidDataKey): Promise<void> => fail(),
    list: async (_query: VoidDataListQuery) => fail(),
    query: async <T = unknown>(_query: VoidDataQuery): Promise<T[]> => fail(),
    tx: async <T>(_work: (data: VoidDataStore) => Promise<T>): Promise<T> => fail(),
    lock: async <T>(
      _key: VoidDataKey,
      _work: (data: VoidDataStore) => Promise<T>,
    ): Promise<T> => fail(),
  };
};

const dispatchBranchAppendSnapshotters = (
  result: BranchAppendResult,
  options?: BranchAppendOptions,
): void => {
  if (!result.snapshot || result.acceptedEvents.length === 0) {
    return;
  }

  dispatchNulleditSnapshotters({
    data: options?.data ?? unavailableDataStore(),
    rootDropId: result.branch.rootDropId,
    branchId: result.branch.branchId,
    snapshotId: result.snapshot.snapshotId,
    parentSnapshotId: result.snapshot.parentSnapshotId,
    branch: result.branch,
    snapshot: result.snapshot,
    frame: { content: result.content },
    acceptedEvents: result.acceptedEvents,
    acceptedDiffRefs: result.acceptedEvents.map((event) =>
      createDropDiffRef({
        rootDropId: result.branch.rootDropId,
        branchId: result.branch.branchId,
        seq: event.seq,
        eventId: event.eventId,
        snapshotId: event.snapshotId,
      }),
    ),
    deduplicatedCount: result.deduplicatedCount,
    totalStored: result.totalStored,
  }, options);
};

/** Appends deduplicated events to a branch and creates the next branch snapshot. */
export const appendEventsToBranch = async (
  bucket: VoidBlobStore,
  branch: DropBranchRecord,
  events: DropDiffEvent[],
  options?: BranchAppendOptions,
  db?: VoidSqlStore,
): Promise<BranchAppendResult> => {
  const result = await withBranchMutationLock(
    bucket,
    branch.rootDropId,
    branch.branchId,
    async () => {
      const latestBranch = await readBranch(
        bucket,
        branch.rootDropId,
        branch.branchId,
        db,
      );
      if (!latestBranch) {
        throw new Error("Branch not found.");
      }

      const upgradedBranch = await ensureBranchHeapV2(bucket, latestBranch, db);
      const currentContent = await readBranchContent(
        bucket,
        upgradedBranch.rootDropId,
        upgradedBranch.branchId,
        upgradedBranch.headSnapshotId,
        db,
      );
      if (currentContent === null) {
        throw new Error("Branch head content is missing.");
      }

      const seenEventIds = new Set<string>();
      const acceptedInput: Array<{ event: DropDiffEvent; dedupeKey: string }> = [];

      for (const event of events) {
        if (seenEventIds.has(event.eventId)) {
          continue;
        }
        seenEventIds.add(event.eventId);

        const dedupeKey = createBranchDiffEventIdKey(
          upgradedBranch.rootDropId,
          upgradedBranch.branchId,
          event.eventId,
        );
        const alreadyStored = await hasBranchDiffEventId(
          bucket,
          upgradedBranch.rootDropId,
          upgradedBranch.branchId,
          event.eventId,
          db,
        );
        if (alreadyStored) {
          continue;
        }

        acceptedInput.push({ event, dedupeKey });
      }

      if (acceptedInput.length === 0) {
        const headSeq =
          typeof upgradedBranch.headEventSeq === "number"
            ? upgradedBranch.headEventSeq
            : -1;
        return {
          branch: upgradedBranch,
          snapshot: null,
          content: currentContent,
          acceptedEvents: [],
          deduplicatedCount: events.length,
          totalStored: headSeq + 1,
        };
      }

      const nextSnapshotId = upgradedBranch.headSnapshotId + 1;
      const nextSeqStart =
        typeof upgradedBranch.headEventSeq === "number"
          ? upgradedBranch.headEventSeq + 1
          : 0;

      const acceptedEvents = acceptedInput.map(({ event }, index) => ({
        ...event,
        seq: nextSeqStart + index,
        snapshotId: nextSnapshotId,
      }));

      const nextContent = applyBranchDiffEvents(currentContent, acceptedEvents);
      const patchStartSeq = acceptedEvents[0].seq;
      const patchEndSeq = acceptedEvents[acceptedEvents.length - 1].seq;

      const checkpointInterval = Math.max(
        1,
        upgradedBranch.checkpointInterval ?? DEFAULT_CHECKPOINT_INTERVAL,
      );
      // Checkpoints are periodic to cap replay cost without storing full plaintext for every event.
      const shouldCheckpoint = nextSnapshotId % checkpointInterval === 0;
      const checkpointObjectKey = shouldCheckpoint
        ? resolveSnapshotCheckpointKey(
            upgradedBranch.rootDropId,
            upgradedBranch.branchId,
            nextSnapshotId,
          )
        : undefined;

      const createdAt = Date.now();
      const snapshot: DropSnapshotRecord = {
        version: 1,
        snapshotId: nextSnapshotId,
        rootDropId: upgradedBranch.rootDropId,
        branchId: upgradedBranch.branchId,
        parentSnapshotId: upgradedBranch.headSnapshotId,
        seq: nextSnapshotId,
        eventIds: acceptedEvents.map((event) => event.eventId),
        checkpointed: shouldCheckpoint,
        patchStartSeq,
        patchEndSeq,
        checkpointKey: checkpointObjectKey,
        textLength: nextContent.length,
        createdAt,
      };

      const nextBranch: DropBranchRecord = {
        ...upgradedBranch,
        headSnapshotId: nextSnapshotId,
        snapshotHeapVersion: 2,
        headEventSeq: patchEndSeq,
        checkpointInterval,
        updatedAt: createdAt,
      };

      await Promise.all(
        acceptedEvents.map((event) =>
          writeBranchDiffEvent(
            bucket,
            upgradedBranch.rootDropId,
            upgradedBranch.branchId,
            event,
            db,
          ),
        ),
      );

      await writeSnapshot(bucket, snapshot, db);

      if (shouldCheckpoint) {
        await writeSnapshotCheckpoint(
          bucket,
          upgradedBranch.rootDropId,
          upgradedBranch.branchId,
          nextSnapshotId,
          nextContent,
          checkpointObjectKey,
        );
      }

      await writeBranch(bucket, nextBranch, db);

      await Promise.all(
        acceptedInput.map(({ dedupeKey }, index) =>
          bucket.put(dedupeKey, String(acceptedEvents[index].seq), {
            httpMetadata: { contentType: "text/plain" },
          }),
        ),
      );

      return {
        branch: nextBranch,
        snapshot,
        content: nextContent,
        acceptedEvents,
        deduplicatedCount: events.length - acceptedEvents.length,
        totalStored: patchEndSeq + 1,
      };
    },
  );

  dispatchBranchAppendSnapshotters(result, options);
  return result;
};

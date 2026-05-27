import type { R2Bucket } from "@cloudflare/workers-types";
import type {
  DropBranchRecord,
  DropSnapshotRecord,
} from "../../../shared/drop/branch";
import type { DropDiffEvent } from "../../../shared/drop/diff";
import {
  DEFAULT_CHECKPOINT_INTERVAL,
  createBranchDiffEventIdKey,
  createBranchDiffEventKey,
} from "./branchKeys";
import { applyBranchDiffEvents, readBranchContent } from "./branchContent";
import { ensureBranchHeapV2 } from "./branchLifecycleService";
import { withBranchMutationLock } from "./branchMutationLock";
import {
  readBranch,
  resolveSnapshotCheckpointKey,
  writeBranch,
  writeR2Json,
  writeSnapshot,
  writeSnapshotCheckpoint,
} from "./branchRepository";

/** Context shared with asynchronous branch append observers. */
export interface BranchAppendObserverContext {
  bucket: R2Bucket;
  branch: DropBranchRecord;
  snapshot: DropSnapshotRecord;
  content: string;
  acceptedEvents: DropDiffEvent[];
  deduplicatedCount: number;
  totalStored: number;
}

/** Observer callbacks fired after branch diff events are accepted and snapshotted. */
export interface BranchAppendObserver {
  id: string;
  onDiffAccepted?(
    event: DropDiffEvent,
    context: BranchAppendObserverContext,
  ): Promise<void> | void;
  onSnapshotCreated?(
    snapshot: DropSnapshotRecord,
    context: BranchAppendObserverContext,
  ): Promise<void> | void;
}

/** Options controlling observer dispatch for a branch append operation. */
export interface BranchAppendObserverOptions {
  observers?: BranchAppendObserver[];
  waitUntil?: (promise: Promise<void>) => void;
  onObserverError?: (error: unknown, observerId: string) => void;
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

const dispatchBranchAppendObservers = (
  bucket: R2Bucket,
  result: BranchAppendResult,
  options?: BranchAppendObserverOptions,
): void => {
  const observers = options?.observers ?? [];
  if (!result.snapshot || result.acceptedEvents.length === 0 || observers.length === 0) {
    return;
  }

  const context: BranchAppendObserverContext = {
    bucket,
    branch: result.branch,
    snapshot: result.snapshot,
    content: result.content,
    acceptedEvents: result.acceptedEvents,
    deduplicatedCount: result.deduplicatedCount,
    totalStored: result.totalStored,
  };

  const observerTask = Promise.all(
    observers.map(async (observer) => {
      try {
        for (const event of result.acceptedEvents) {
          await observer.onDiffAccepted?.(event, context);
        }
        await observer.onSnapshotCreated?.(result.snapshot as DropSnapshotRecord, context);
      } catch (error) {
        options?.onObserverError?.(error, observer.id);
      }
    }),
  ).then(() => undefined);

  if (options?.waitUntil) {
    try {
      options.waitUntil(observerTask);
      return;
    } catch (error) {
      options.onObserverError?.(error, "waitUntil");
    }
  }

  void observerTask;
};

/** Appends deduplicated events to a branch and creates the next branch snapshot. */
export const appendEventsToBranch = async (
  bucket: R2Bucket,
  branch: DropBranchRecord,
  events: DropDiffEvent[],
  options?: BranchAppendObserverOptions,
): Promise<BranchAppendResult> => {
  const result = await withBranchMutationLock(
    bucket,
    branch.rootDropId,
    branch.branchId,
    async () => {
      const latestBranch = await readBranch(bucket, branch.rootDropId, branch.branchId);
      if (!latestBranch) {
        throw new Error("Branch not found.");
      }

      const upgradedBranch = await ensureBranchHeapV2(bucket, latestBranch);
      const currentContent = await readBranchContent(
        bucket,
        upgradedBranch.rootDropId,
        upgradedBranch.branchId,
        upgradedBranch.headSnapshotId,
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
        const alreadyStored = await bucket.head(dedupeKey);
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
          writeR2Json(
            bucket,
            createBranchDiffEventKey(
              upgradedBranch.rootDropId,
              upgradedBranch.branchId,
              event.seq,
            ),
            event,
          ),
        ),
      );

      await writeSnapshot(bucket, snapshot);

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

      await writeBranch(bucket, nextBranch);

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

  dispatchBranchAppendObservers(bucket, result, options);
  return result;
};

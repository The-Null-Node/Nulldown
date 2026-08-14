import type {
  DropBranchRecord,
  DropSnapshotRecord,
} from "../../../../shared/drop/branch";
import type {
  DropDiffEvent,
  DropDiffEventAcknowledgement,
} from "../../../../shared/drop/diff";
import { serializeCanonicalJson } from "../../../../shared/drop/types";
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
  dispatchNulleditSnapshottersForCommit,
  flushBranchCommitBufferSnapshotters,
  type BranchAcceptedCommit,
  type BranchCommitBuffer,
  type BranchCommitBufferDecision,
  type NulleditSnapshotter,
  type NulleditSnapshotterDispatchOptions,
} from "../../../../src/server/nulledit";
import {
  DEFAULT_CHECKPOINT_INTERVAL,
  createBranchDiffEventIdKey,
} from "../branches/storage/keys";
import {
  applyBranchDiffEvents,
  readBranchContent,
} from "../branches/content/replay";
import { ensureBranchHeapV2ForMutation } from "../branches/lifecycle/service";
import { withBranchMutationLock } from "../branches/storage/mutationLock";
import { createBranchDiffRepository } from "../branches/storage/diffLogRepository";
import {
  createBranchRepository,
  resolveSnapshotCheckpointKey,
} from "../branches/storage/repository";

/** Options controlling Nulledit snapshotter dispatch for a branch append operation. */
export interface BranchAppendOptions extends NulleditSnapshotterDispatchOptions {
  /** Functional datastore used by snapshotters; Cloudflare bindings are adapted when omitted. */
  data?: VoidDataStore;
  /** Snapshotters fired after diff events are accepted and snapshotted. */
  snapshotters?: NulleditSnapshotter[];
  /** Optional policy that can buffer or skip derived snapshotter work. */
  commitBuffer?: BranchCommitBuffer;
}

/** Result returned after appending and snapshotting accepted branch diff events. */
export interface BranchAppendResult {
  branch: DropBranchRecord;
  snapshot: DropSnapshotRecord | null;
  content: string;
  acceptedEvents: DropDiffEvent[];
  /** Acknowledgements for new and idempotently replayed input events. */
  acknowledgements: DropDiffEventAcknowledgement[];
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
    putMany: async (): Promise<void> => fail(),
    delete: async (_key: VoidDataKey): Promise<void> => fail(),
    list: async (_query: VoidDataListQuery) => fail(),
    query: async <T = unknown>(_query: VoidDataQuery): Promise<T[]> => fail(),
    tx: async <T>(_work: (data: VoidDataStore) => Promise<T>): Promise<T> =>
      fail(),
    lock: async <T>(
      _key: VoidDataKey,
      _work: (data: VoidDataStore) => Promise<T>,
    ): Promise<T> => fail(),
  };
};

const createAcceptedCommit = (
  result: BranchAppendResult,
): BranchAcceptedCommit | null => {
  if (!result.snapshot || result.acceptedEvents.length === 0) return null;
  return {
    rootDropId: result.branch.rootDropId,
    branchId: result.branch.branchId,
    snapshotId: result.snapshot.snapshotId,
    parentSnapshotId: result.snapshot.parentSnapshotId,
    branch: result.branch,
    snapshot: result.snapshot,
    content: result.content,
    acceptedEvents: result.acceptedEvents,
    deduplicatedCount: result.deduplicatedCount,
    totalStored: result.totalStored,
  };
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const scheduleBufferedCommitFlush = (
  commit: BranchAcceptedCommit,
  decision: Extract<BranchCommitBufferDecision, { mode: "buffer" }>,
  options: BranchAppendOptions,
): void => {
  const { commitBuffer } = options;
  if (!commitBuffer?.flush) {
    return;
  }

  const flushAfterMs = decision.flushReason
    ? 0
    : Math.max(0, Math.floor(decision.flushAfterMs));
  const reason = decision.flushReason ?? "branch-idle";
  const data = options.data ?? unavailableDataStore();
  const task = (async () => {
    try {
      if (flushAfterMs > 0) {
        await delay(flushAfterMs);
      }
      await flushBranchCommitBufferSnapshotters({
        ...options,
        data,
        commitBuffer,
        rootDropId: commit.rootDropId,
        branchId: commit.branchId,
        reason,
      });
    } catch (error) {
      options.onSnapshotterError?.(error, "branch.commit-buffer.flush");
    }
  })();

  if (options.waitUntil) {
    try {
      options.waitUntil(task);
      return;
    } catch (error) {
      options.onSnapshotterError?.(error, "waitUntil");
    }
  }

  void task;
};

const dispatchBranchAppendSnapshotters = async (
  result: BranchAppendResult,
  options?: BranchAppendOptions,
): Promise<void> => {
  const commit = createAcceptedCommit(result);
  if (!commit) {
    return;
  }

  if (options?.commitBuffer) {
    try {
      const decision = await options.commitBuffer.appendAcceptedCommit(commit);
      if (decision.mode !== "write-through") {
        if (decision.mode === "buffer") {
          scheduleBufferedCommitFlush(commit, decision, options);
        }
        return;
      }
    } catch (error) {
      options.onSnapshotterError?.(error, "branch.commit-buffer");
    }
  }

  dispatchNulleditSnapshottersForCommit(commit, {
    ...options,
    data: options?.data ?? unavailableDataStore(),
  });
};

const comparableEvent = (event: DropDiffEvent) => ({
  eventId: event.eventId,
  dropId: event.dropId,
  sourceClientId: event.sourceClientId,
  createdAt: event.createdAt,
  ops: event.ops,
  metadata: event.metadata,
});

const hasSameEventPayload = (
  input: DropDiffEvent,
  stored: DropDiffEvent,
): boolean =>
  serializeCanonicalJson(comparableEvent(input)) ===
  serializeCanonicalJson(comparableEvent(stored));

const committedAcknowledgementFor = async (
  branchRepository: ReturnType<typeof createBranchRepository>,
  branch: DropBranchRecord,
  event: DropDiffEvent,
): Promise<DropDiffEventAcknowledgement | null> => {
  const headSeq =
    typeof branch.headEventSeq === "number" ? branch.headEventSeq : -1;
  if (event.seq < 0 || event.seq > headSeq) return null;

  let snapshotId: number | null = branch.headSnapshotId;
  const visited = new Set<number>();
  while (snapshotId !== null) {
    if (visited.has(snapshotId)) return null;
    visited.add(snapshotId);
    const snapshot = await branchRepository.readSnapshot(
      branch.rootDropId,
      branch.branchId,
      snapshotId,
    );
    if (
      !snapshot ||
      snapshot.rootDropId !== branch.rootDropId ||
      snapshot.branchId !== branch.branchId ||
      snapshot.snapshotId !== snapshotId
    ) {
      return null;
    }
    if (snapshot.eventIds.includes(event.eventId)) {
      if (
        (event.snapshotId !== undefined && event.snapshotId !== snapshot.snapshotId) ||
        (snapshot.patchStartSeq !== null &&
          snapshot.patchStartSeq !== undefined &&
          event.seq < snapshot.patchStartSeq) ||
        (snapshot.patchEndSeq !== null &&
          snapshot.patchEndSeq !== undefined &&
          event.seq > snapshot.patchEndSeq)
      ) {
        return null;
      }
      return {
        eventId: event.eventId,
        seq: event.seq,
        snapshotId: snapshot.snapshotId,
        status: "duplicate",
      };
    }
    if (
      snapshot.parentSnapshotId !== null &&
      snapshot.parentSnapshotId >= snapshot.snapshotId
    ) {
      return null;
    }
    snapshotId = snapshot.parentSnapshotId;
  }
  return null;
};

/** Appends deduplicated events to a branch and creates the next branch snapshot. */
export const appendEventsToBranch = async (
  bucket: VoidBlobStore,
  branch: DropBranchRecord,
  events: DropDiffEvent[],
  options?: BranchAppendOptions,
  db?: VoidSqlStore,
): Promise<BranchAppendResult> => {
  const branchRepository = createBranchRepository({ blobs: bucket, sql: db });
  const branchDiffRepository = createBranchDiffRepository({
    blobs: bucket,
    sql: db,
  });
  const result = await withBranchMutationLock(
    bucket,
    branch.rootDropId,
    branch.branchId,
    async (lock) => {
      const current = await branchRepository.readBranchWithEtag(
        branch.rootDropId,
        branch.branchId,
      );
      if (!current) {
        throw new Error("Branch not found.");
      }

      const upgradedBranch = await ensureBranchHeapV2ForMutation(
        bucket,
        current.branch,
        lock,
        db,
        current.etag,
      );
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

      const seenEvents = new Map<string, DropDiffEvent>();
      const uniqueInputEvents: DropDiffEvent[] = [];
      const existingAcknowledgements = new Map<
        string,
        DropDiffEventAcknowledgement
      >();
      const acceptedInput: DropDiffEvent[] = [];
      const headSeq =
        typeof upgradedBranch.headEventSeq === "number"
          ? upgradedBranch.headEventSeq
          : -1;

      for (const event of events) {
        const priorInput = seenEvents.get(event.eventId);
        if (priorInput) {
          if (!hasSameEventPayload(event, priorInput)) {
            throw new Error("diff_event_id_reused");
          }
          continue;
        }

        seenEvents.set(event.eventId, event);
        uniqueInputEvents.push(event);

        const existing = await branchDiffRepository.lookupBranchDiffEventIdentity(
          upgradedBranch.rootDropId,
          upgradedBranch.branchId,
          event.eventId,
        );

        if (existing.status === "invalid") {
          throw new Error("diff_event_identity_invalid");
        }

        if (existing.status === "found") {
          if (!hasSameEventPayload(event, existing.event)) {
            throw new Error("diff_event_id_reused");
          }
          const acknowledgement = await committedAcknowledgementFor(
            branchRepository,
            upgradedBranch,
            existing.event,
          );
          if (!acknowledgement) {
            const expectedSeq = headSeq + acceptedInput.length + 1;
            if (
              !existing.hasMarker &&
              existing.event.seq === expectedSeq &&
              existing.event.snapshotId === upgradedBranch.headSnapshotId + 1
            ) {
              // Resume an append interrupted before branch-head publication.
              acceptedInput.push(event);
              continue;
            }
            throw new Error("diff_event_outcome_unknown");
          }
          existingAcknowledgements.set(event.eventId, acknowledgement);
          await branchDiffRepository.writeBranchDiffEvent(
            upgradedBranch.rootDropId,
            upgradedBranch.branchId,
            {
              ...existing.event,
              snapshotId: acknowledgement.snapshotId,
            },
          );
          await branchDiffRepository.writeBranchDiffEventIdMarker(
            upgradedBranch.rootDropId,
            upgradedBranch.branchId,
            {
              ...existing.event,
              snapshotId: acknowledgement.snapshotId,
            },
          );
          continue;
        }

        acceptedInput.push(event);
      }

      const acknowledgementsFor = (
        acceptedEvents: DropDiffEvent[],
      ): DropDiffEventAcknowledgement[] => {
        const acceptedAcknowledgements = new Map(
          acceptedEvents.map((event) => [
            event.eventId,
            {
              eventId: event.eventId,
              seq: event.seq,
              snapshotId: event.snapshotId ?? nextSnapshotId,
              status: "accepted" as const,
            },
          ]),
        );
        return uniqueInputEvents
          .map(
            (event) =>
              existingAcknowledgements.get(event.eventId) ??
              acceptedAcknowledgements.get(event.eventId),
          )
          .filter(
            (
              acknowledgement,
            ): acknowledgement is DropDiffEventAcknowledgement =>
              Boolean(acknowledgement),
          );
      };

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
          acknowledgements: acknowledgementsFor([]),
          deduplicatedCount: events.length,
          totalStored: headSeq + 1,
        };
      }

      for (const [index, event] of acceptedInput.entries()) {
        const followsSeq = event.metadata?.followsSeq;
        if (followsSeq !== undefined && followsSeq !== headSeq + index) {
          throw new Error("diff_predecessor_mismatch");
        }
      }

      const nextSnapshotId = upgradedBranch.headSnapshotId + 1;
      const nextSeqStart =
        headSeq + 1;

      const acceptedEvents = acceptedInput.map((event, index) => ({
        ...event,
        seq: nextSeqStart + index,
        snapshotId: nextSnapshotId,
      }));

      const nextContent = applyBranchDiffEvents(currentContent, acceptedEvents);
      const patchStartSeq = acceptedEvents[0].seq;
      const patchEndSeq = acceptedEvents[acceptedEvents.length - 1].seq;

      for (const event of acceptedEvents) {
        const storedAtSequence = await branchDiffRepository.readBranchDiffEventBySeq(
          upgradedBranch.rootDropId,
          upgradedBranch.branchId,
          event.seq,
        );
        if (storedAtSequence && !hasSameEventPayload(event, storedAtSequence)) {
          throw new Error("diff_predecessor_mismatch");
        }
      }

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

      await lock.beginCommit();
      await Promise.all(
        acceptedEvents.map((event) =>
          branchDiffRepository.writeBranchDiffEvent(
            upgradedBranch.rootDropId,
            upgradedBranch.branchId,
            event,
          ),
        ),
      );

      await branchRepository.writeSnapshot(snapshot);

      if (shouldCheckpoint) {
        await branchRepository.writeSnapshotCheckpoint(
          upgradedBranch.rootDropId,
          upgradedBranch.branchId,
          nextSnapshotId,
          nextContent,
          checkpointObjectKey,
        );
      }

      const branchEtag = upgradedBranch === current.branch
        ? current.etag
        : (await branchRepository.readBranchWithEtag(
            upgradedBranch.rootDropId,
            upgradedBranch.branchId,
          ))?.etag;
      if (!branchEtag || !(await branchRepository.writeBranch(nextBranch, branchEtag))) {
        throw new Error("branch_head_fenced_write_failed");
      }

      await Promise.all(
        acceptedEvents.map((event) =>
          branchDiffRepository.writeBranchDiffEventIdMarker(
            upgradedBranch.rootDropId,
            upgradedBranch.branchId,
            event,
          ),
        ),
      );
      await Promise.all(
        acceptedEvents.map((event) =>
          bucket.put(
            createBranchDiffEventIdKey(
              upgradedBranch.rootDropId,
              upgradedBranch.branchId,
              event.eventId,
            ),
            String(event.seq),
            {
              httpMetadata: { contentType: "text/plain" },
              onlyIf: { etagDoesNotMatch: "*" },
            },
          ),
        ),
      );

      return {
        branch: nextBranch,
        snapshot,
        content: nextContent,
        acceptedEvents,
        acknowledgements: acknowledgementsFor(acceptedEvents),
        deduplicatedCount: events.length - acceptedEvents.length,
        totalStored: patchEndSeq + 1,
      };
    },
  );

  await dispatchBranchAppendSnapshotters(result, options);
  return result;
};

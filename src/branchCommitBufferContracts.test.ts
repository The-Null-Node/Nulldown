import type { DropBranchRecord, DropSnapshotRecord } from "../shared/drop/branch";
import type { DropDiffEvent } from "../shared/drop/diff";
import {
  createInMemoryBranchCommitBuffer,
  createNulleditSnapshotterRegistry,
  flushBranchCommitBufferSnapshotters,
  type BranchAcceptedCommit,
  type NulleditSnapshotter,
} from "./server/nulledit";
import { createMemoryVoidDataStore } from "./server/memoryDataStore";

const rootDropId = "buffer-root";
const branchId = "owner";

const branch: DropBranchRecord = {
  version: 1,
  branchId,
  rootDropId,
  baseDropId: rootDropId,
  mode: "owner",
  status: "active",
  ownerAccountId: "acct_1",
  writerAccountId: null,
  writerClientId: null,
  headSnapshotId: 1,
  snapshotHeapVersion: 2,
  headEventSeq: 0,
  createdAt: 100,
  updatedAt: 101,
};

const makeCommit = (
  snapshotId: number,
  content = "content",
): BranchAcceptedCommit => {
  const event: DropDiffEvent = {
    eventId: `evt-${snapshotId}`,
    seq: snapshotId - 1,
    dropId: rootDropId,
    sourceClientId: "client",
    createdAt: 100 + snapshotId,
    snapshotId,
    ops: [{ type: "insert", start: 0, end: 0, text: content }],
  };
  const snapshot: DropSnapshotRecord = {
    version: 1,
    snapshotId,
    rootDropId,
    branchId,
    parentSnapshotId: snapshotId - 1,
    seq: snapshotId,
    eventIds: [event.eventId],
    checkpointed: false,
    patchStartSeq: event.seq,
    patchEndSeq: event.seq,
    textLength: content.length,
    createdAt: event.createdAt,
  };

  return {
    rootDropId,
    branchId,
    snapshotId,
    parentSnapshotId: snapshot.parentSnapshotId,
    branch: { ...branch, headSnapshotId: snapshotId, headEventSeq: event.seq },
    snapshot,
    content,
    acceptedEvents: [event],
    deduplicatedCount: 0,
    totalStored: snapshotId,
  };
};

describe("BranchCommitBuffer contracts", () => {
  it("registers persistent snapshotters with defensive list copies", () => {
    const initial: NulleditSnapshotter = {
      id: "initial-snapshotter",
      snapshot() {},
    };
    const registered: NulleditSnapshotter = {
      id: "registered-snapshotter",
      snapshot() {},
    };
    const registry = createNulleditSnapshotterRegistry([initial]);

    const copy = registry.list();
    copy.length = 0;
    expect(registry.list()).toEqual([initial]);

    const unsubscribe = registry.register(registered);
    expect(registry.list()).toEqual([initial, registered]);

    unsubscribe();
    unsubscribe();
    expect(registry.list()).toEqual([initial]);
  });

  it("writes through cold commits and buffers once a branch is hot", () => {
    const buffer = createInMemoryBranchCommitBuffer({
      thresholds: { hotBranchEventCount: 2, flushAfterMs: 50 },
    });

    expect(buffer.appendAcceptedCommit(makeCommit(1))).toEqual({
      mode: "write-through",
      reason: "cold-branch",
    });
    expect(buffer.appendAcceptedCommit(makeCommit(2))).toEqual(
      expect.objectContaining({
        mode: "buffer",
        reason: "hot-branch",
        flushAfterMs: 50,
        bufferedEventCount: 1,
      }),
    );

    expect(buffer.flush?.({ rootDropId, branchId, reason: "explicit-query" })).toEqual(
      expect.objectContaining({
        reason: "explicit-query",
        bufferedEventCount: 1,
        latestSnapshotId: 2,
        commits: [expect.objectContaining({ snapshotId: 2 })],
      }),
    );
  });

  it("requests immediate flushes for event, byte, and age thresholds", () => {
    let now = 0;
    const buffer = createInMemoryBranchCommitBuffer({
      now: () => now,
      thresholds: {
        hotBranchEventCount: 1,
        maxBufferedEventCount: 2,
        maxBufferedBytes: 10_000,
        maxBufferedAgeMs: 100,
      },
    });

    expect(buffer.appendAcceptedCommit(makeCommit(1))).toEqual(
      expect.objectContaining({ flushAfterMs: 100, flushReason: undefined }),
    );
    expect(buffer.appendAcceptedCommit(makeCommit(2))).toEqual(
      expect.objectContaining({ flushAfterMs: 0, flushReason: "event-threshold" }),
    );
    buffer.flush?.({ rootDropId, branchId, reason: "event-threshold" });

    const byteBuffer = createInMemoryBranchCommitBuffer({
      thresholds: { hotBranchEventCount: 1, maxBufferedBytes: 8 },
      estimateCommitBytes: () => 9,
    });
    expect(byteBuffer.appendAcceptedCommit(makeCommit(3))).toEqual(
      expect.objectContaining({ flushAfterMs: 0, flushReason: "byte-threshold" }),
    );

    const ageBuffer = createInMemoryBranchCommitBuffer({
      now: () => now,
      thresholds: { hotBranchEventCount: 1, maxBufferedAgeMs: 10 },
    });
    ageBuffer.appendAcceptedCommit(makeCommit(4));
    now = 11;
    expect(ageBuffer.appendAcceptedCommit(makeCommit(5))).toEqual(
      expect.objectContaining({ flushAfterMs: 0, flushReason: "age-threshold" }),
    );

    expect(ageBuffer.flush?.({ rootDropId, branchId, reason: "branch-idle" })).toEqual(
      expect.objectContaining({ reason: "branch-idle", bufferedEventCount: 2 }),
    );
  });

  it("invalidates buffered branch state", () => {
    const buffer = createInMemoryBranchCommitBuffer({
      thresholds: { hotBranchEventCount: 1 },
    });

    expect(buffer.appendAcceptedCommit(makeCommit(1))).toEqual(
      expect.objectContaining({ mode: "buffer", bufferedEventCount: 1 }),
    );

    buffer.invalidate?.({ rootDropId, branchId, reason: "query-repair" });

    expect(buffer.flush?.({ rootDropId, branchId, reason: "manual" })).toEqual(
      expect.objectContaining({ commits: [], bufferedEventCount: 0 }),
    );
    expect(buffer.appendAcceptedCommit(makeCommit(2))).toEqual(
      expect.objectContaining({ mode: "buffer", bufferedEventCount: 1 }),
    );
  });

  it("advertises branch-idle flush delay while below thresholds", () => {
    const buffer = createInMemoryBranchCommitBuffer({
      thresholds: { hotBranchEventCount: 1, branchIdleMs: 75, flushAfterMs: 250 },
    });

    expect(buffer.appendAcceptedCommit(makeCommit(1))).toEqual(
      expect.objectContaining({ flushAfterMs: 75, flushReason: undefined }),
    );
  });

  it("flushes buffered commits into snapshotters", async () => {
    const buffer = createInMemoryBranchCommitBuffer({
      thresholds: { hotBranchEventCount: 1 },
    });
    const calls: string[] = [];

    buffer.appendAcceptedCommit(makeCommit(1));
    const result = await flushBranchCommitBufferSnapshotters({
      commitBuffer: buffer,
      data: createMemoryVoidDataStore(),
      rootDropId,
      branchId,
      reason: "explicit-query",
      snapshotters: [
        {
          id: "flush-snapshotter",
          snapshot(context) {
            calls.push(
              `${context.snapshotId}:${context.acceptedEvents[0]?.eventId}`,
            );
          },
        },
      ],
    });

    expect(result).toEqual(
      expect.objectContaining({
        reason: "explicit-query",
        bufferedEventCount: 1,
        latestSnapshotId: 1,
      }),
    );
    expect(calls).toEqual(["1:evt-1"]);
    expect(buffer.flush?.({ rootDropId, branchId, reason: "manual" })).toEqual(
      expect.objectContaining({ commits: [], bufferedEventCount: 0 }),
    );
  });
});

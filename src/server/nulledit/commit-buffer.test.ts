import { createInMemoryBranchCommitBuffer } from "./commit-buffer";
import { branchId, makeCommit, rootDropId } from "./commit-buffer.fixtures";

describe("BranchCommitBuffer contracts", () => {
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

    expect(
      buffer.flush?.({ rootDropId, branchId, reason: "explicit-query" }),
    ).toEqual(
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
      expect.objectContaining({
        flushAfterMs: 0,
        flushReason: "event-threshold",
      }),
    );
    buffer.flush?.({ rootDropId, branchId, reason: "event-threshold" });

    const byteBuffer = createInMemoryBranchCommitBuffer({
      thresholds: { hotBranchEventCount: 1, maxBufferedBytes: 8 },
      estimateCommitBytes: () => 9,
    });
    expect(byteBuffer.appendAcceptedCommit(makeCommit(3))).toEqual(
      expect.objectContaining({
        flushAfterMs: 0,
        flushReason: "byte-threshold",
      }),
    );

    const ageBuffer = createInMemoryBranchCommitBuffer({
      now: () => now,
      thresholds: { hotBranchEventCount: 1, maxBufferedAgeMs: 10 },
    });
    ageBuffer.appendAcceptedCommit(makeCommit(4));
    now = 11;
    expect(ageBuffer.appendAcceptedCommit(makeCommit(5))).toEqual(
      expect.objectContaining({
        flushAfterMs: 0,
        flushReason: "age-threshold",
      }),
    );

    expect(
      ageBuffer.flush?.({ rootDropId, branchId, reason: "branch-idle" }),
    ).toEqual(
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
      thresholds: {
        hotBranchEventCount: 1,
        branchIdleMs: 75,
        flushAfterMs: 250,
      },
    });

    expect(buffer.appendAcceptedCommit(makeCommit(1))).toEqual(
      expect.objectContaining({ flushAfterMs: 75, flushReason: undefined }),
    );
  });
});

import { createMemoryRuntimeDataStore } from "../memory-data-store";
import { createInMemoryBranchCommitBuffer } from "./commit-buffer";
import { branchId, makeCommit, rootDropId } from "./commit-buffer.fixtures";
import { flushBranchCommitBufferSnapshotters } from "./dispatch";

describe("Nulledit snapshotter flush dispatch contracts", () => {
  it("flushes buffered commits into snapshotters", async () => {
    const buffer = createInMemoryBranchCommitBuffer({
      thresholds: { hotBranchEventCount: 1 },
    });
    const calls: string[] = [];

    buffer.appendAcceptedCommit(makeCommit(1));
    const result = await flushBranchCommitBufferSnapshotters({
      commitBuffer: buffer,
      data: createMemoryRuntimeDataStore(),
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

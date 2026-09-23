import type { R2Bucket } from "@cloudflare/workers-types";
import { resolveBranchForActor } from "../branches/lifecycle";
import { readBranch, readSnapshot } from "../branches/storage/repository";
import {
  accountId,
  createSeededBucket,
  makeEvent,
  rootDropId,
} from "../diffs/testing/storage-fixture";
import { createInMemoryBranchCommitBuffer } from "../../../../src/server/nulledit/commit-buffer";
import type {
  BranchCommitBuffer,
  NulleditSnapshotter,
} from "../../../../src/server/nulledit/types";
import { appendEventsToBranch } from "./service";

describe("Nulledit branch append contracts", () => {
  it("runs Nulledit snapshotters after accepted writes", async () => {
    const bucket = createSeededBucket();
    const { branch } = await resolveBranchForActor(
      bucket as unknown as R2Bucket,
      rootDropId,
      accountId,
      null,
    );
    const event = makeEvent({
      eventId: "evt-observed",
      sourceClientId: "writer-observed",
      text: "O",
      createdAt: 107,
    });
    const calls: string[] = [];
    const waitUntilPromises: Promise<void>[] = [];
    const bufferedCommits: string[] = [];
    const commitBuffer: BranchCommitBuffer = {
      appendAcceptedCommit(commit) {
        bufferedCommits.push(
          `${commit.branchId}:${commit.snapshotId}:${commit.acceptedEvents.length}`,
        );
        return { mode: "write-through", reason: "cold-branch" };
      },
    };
    const snapshotter: NulleditSnapshotter = {
      id: "snapshotter-1",
      snapshot(context) {
        for (const event of context.acceptedEvents) {
          calls.push(
            `event:${event.eventId}:${event.seq}:${context.branch.headSnapshotId}`,
          );
        }
        calls.push(
          `snapshot:${context.snapshotId}:${context.acceptedEvents.length}:${context.totalStored}`,
        );
      },
    };

    const appended = await appendEventsToBranch(
      bucket as unknown as R2Bucket,
      branch,
      [event],
      {
        snapshotters: [snapshotter],
        commitBuffer,
        waitUntil: (promise) => {
          waitUntilPromises.push(promise);
        },
      },
    );

    expect(appended.acceptedEvents).toHaveLength(1);
    expect(appended.snapshot?.snapshotId).toBe(1);
    expect(bufferedCommits).toEqual([`${branch.branchId}:1:1`]);
    expect(waitUntilPromises).toHaveLength(1);
    await waitUntilPromises[0];
    expect(calls).toEqual(["event:evt-observed:0:1", "snapshot:1:1:1"]);
  });

  it("runs Nulledit snapshotter phases in order", async () => {
    const bucket = createSeededBucket();
    const { branch } = await resolveBranchForActor(
      bucket as unknown as R2Bucket,
      rootDropId,
      accountId,
      null,
    );
    const event = makeEvent({
      eventId: "evt-phase-order",
      sourceClientId: "writer-phase-order",
      text: "P",
      createdAt: 111,
    });
    const calls: string[] = [];
    const waitUntilPromises: Promise<void>[] = [];
    const snapshotters: NulleditSnapshotter[] = [
      {
        id: "secondary-snapshotter",
        phase: "secondary",
        snapshot() {
          calls.push(`secondary:${calls.includes("primary:end")}`);
        },
      },
      {
        id: "extended-snapshotter",
        snapshot() {
          calls.push(`extended:${calls.includes("secondary:true")}`);
        },
      },
      {
        id: "primary-snapshotter",
        phase: "primary",
        async snapshot() {
          calls.push("primary:start");
          await Promise.resolve();
          calls.push("primary:end");
        },
      },
    ];

    const appended = await appendEventsToBranch(
      bucket as unknown as R2Bucket,
      branch,
      [event],
      {
        snapshotters,
        waitUntil: (promise) => {
          waitUntilPromises.push(promise);
        },
      },
    );

    expect(appended.acceptedEvents).toHaveLength(1);
    await waitUntilPromises[0];
    expect(calls).toEqual([
      "primary:start",
      "primary:end",
      "secondary:true",
      "extended:true",
    ]);
  });

  it("buffers derived snapshotters after primary branch writes", async () => {
    const bucket = createSeededBucket();
    const { branch } = await resolveBranchForActor(
      bucket as unknown as R2Bucket,
      rootDropId,
      accountId,
      null,
    );
    const event = makeEvent({
      eventId: "evt-buffered",
      sourceClientId: "writer-buffered",
      text: "B",
      createdAt: 109,
    });
    const waitUntilPromises: Promise<void>[] = [];
    const calls: string[] = [];
    const commitBuffer: BranchCommitBuffer = {
      appendAcceptedCommit(commit) {
        calls.push(
          `buffer:${commit.snapshotId}:${commit.acceptedEvents.length}`,
        );
        return {
          mode: "buffer",
          reason: "hot-branch",
          flushAfterMs: 100,
          bufferedEventCount: commit.acceptedEvents.length,
        };
      },
    };

    const appended = await appendEventsToBranch(
      bucket as unknown as R2Bucket,
      branch,
      [event],
      {
        snapshotters: [
          {
            id: "must-not-run",
            snapshot() {
              calls.push("snapshotter-ran");
            },
          },
        ],
        commitBuffer,
        waitUntil: (promise) => {
          waitUntilPromises.push(promise);
        },
      },
    );

    expect(appended.acceptedEvents).toHaveLength(1);
    expect(appended.snapshot?.snapshotId).toBe(1);
    expect(waitUntilPromises).toHaveLength(0);
    expect(calls).toEqual(["buffer:1:1"]);
    await expect(
      readBranch(bucket as unknown as R2Bucket, rootDropId, branch.branchId),
    ).resolves.toEqual(expect.objectContaining({ headSnapshotId: 1 }));
    await expect(
      readSnapshot(
        bucket as unknown as R2Bucket,
        rootDropId,
        branch.branchId,
        1,
      ),
    ).resolves.toEqual(expect.objectContaining({ snapshotId: 1 }));
  });

  it("schedules buffered snapshotters when a flush threshold is reached", async () => {
    const bucket = createSeededBucket();
    const { branch } = await resolveBranchForActor(
      bucket as unknown as R2Bucket,
      rootDropId,
      accountId,
      null,
    );
    const event = makeEvent({
      eventId: "evt-threshold-flush",
      sourceClientId: "writer-threshold-flush",
      text: "F",
      createdAt: 110,
    });
    const commitBuffer = createInMemoryBranchCommitBuffer({
      thresholds: { hotBranchEventCount: 1, maxBufferedEventCount: 1 },
    });
    const waitUntilPromises: Promise<void>[] = [];
    const calls: string[] = [];

    const appended = await appendEventsToBranch(
      bucket as unknown as R2Bucket,
      branch,
      [event],
      {
        snapshotters: [
          {
            id: "threshold-snapshotter",
            snapshot(context) {
              calls.push(
                `${context.snapshotId}:${context.acceptedEvents[0]?.eventId}`,
              );
            },
          },
        ],
        commitBuffer,
        waitUntil: (promise) => {
          waitUntilPromises.push(promise);
        },
      },
    );

    expect(appended.acceptedEvents).toHaveLength(1);
    expect(appended.snapshot?.snapshotId).toBe(1);
    expect(waitUntilPromises).toHaveLength(1);
    await waitUntilPromises[0];
    expect(calls).toEqual(["1:evt-threshold-flush"]);
    expect(
      commitBuffer.flush?.({
        rootDropId,
        branchId: branch.branchId,
        reason: "manual",
      }),
    ).toEqual(expect.objectContaining({ commits: [], bufferedEventCount: 0 }));
  });

  it("isolates Nulledit snapshotter failures", async () => {
    const bucket = createSeededBucket();
    const { branch } = await resolveBranchForActor(
      bucket as unknown as R2Bucket,
      rootDropId,
      accountId,
      null,
    );
    const event = makeEvent({
      eventId: "evt-observer-error",
      sourceClientId: "writer-observer-error",
      text: "E",
      createdAt: 108,
    });
    const errors: string[] = [];
    const waitUntilPromises: Promise<void>[] = [];

    const appended = await appendEventsToBranch(
      bucket as unknown as R2Bucket,
      branch,
      [event],
      {
        snapshotters: [
          {
            id: "bad-snapshotter",
            snapshot() {
              throw new Error("snapshotter failed");
            },
          },
        ],
        waitUntil: (promise) => {
          waitUntilPromises.push(promise);
        },
        onSnapshotterError: (_error, snapshotterId) => {
          errors.push(snapshotterId);
        },
      },
    );

    expect(appended.acceptedEvents).toHaveLength(1);
    await waitUntilPromises[0];
    expect(errors).toEqual(["bad-snapshotter"]);
  });
});

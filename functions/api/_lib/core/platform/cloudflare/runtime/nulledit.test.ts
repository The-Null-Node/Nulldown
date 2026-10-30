import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { jest } from "@jest/globals";
import type { DropBranchRecord } from "../../../../../../../shared/drop/branch";
import { createMemoryRuntimeDataStore } from "../../../../../../../src/server/memory-data-store";
import type { NulleditSnapshotContext } from "../../../../../../../src/server/nulledit/types";
import { MemoryBranchCommitStatePlane } from "../../../../../../../src/server/state-plane/memory-commits";
import { resolveBranchForActor } from "../../../../branches/lifecycle";
import {
  accountId,
  createSeededBucket,
  makeEvent,
  MemoryD1Database,
  rootDropId,
} from "../../../../diffs/testing/storage-fixture";
import { createCloudflareBackendRuntime } from "./composition";

describe("Cloudflare Nulledit runtime contracts", () => {
  it("runs server-runtime-registered snapshotters on future appends", async () => {
    const bucket = createSeededBucket();
    const db = new MemoryD1Database();
    const serverRuntime = createCloudflareBackendRuntime({
      R2_BUCKET: bucket as unknown as R2Bucket,
      DB: db as unknown as D1Database,
    }).serverRuntime;
    const { branch } = await resolveBranchForActor(
      bucket as unknown as R2Bucket,
      rootDropId,
      accountId,
      null,
    );
    const event = makeEvent({
      eventId: "evt-provider-registered",
      sourceClientId: "writer-provider-registered",
      text: "R",
      createdAt: 112,
    });
    const calls: string[] = [];
    const waitUntilPromises: Promise<void>[] = [];
    const unsubscribe = serverRuntime.nulledit.registerSnapshotter({
      id: "provider-registered-snapshotter",
      phase: "secondary",
      snapshot(context) {
        calls.push(
          `${context.snapshotId}:${context.acceptedEvents[0]?.eventId}`,
        );
      },
    });

    try {
      const appended = await serverRuntime.nulledit.appendDiffEvents({
        branch,
        events: [event],
        waitUntil: (promise) => {
          waitUntilPromises.push(promise);
        },
      });

      expect(appended.acceptedEvents).toHaveLength(1);
      expect(waitUntilPromises).toHaveLength(1);
      await waitUntilPromises[0];
      expect(calls).toEqual(["1:evt-provider-registered"]);
    } finally {
      unsubscribe();
    }
  });

  it("dispatches registered local batch snapshotters once, honors unsubscribe, and never accesses legacy storage or repair", async () => {
    const branch: DropBranchRecord = {
      version: 1,
      rootDropId,
      branchId: "owner",
      baseDropId: rootDropId,
      mode: "owner",
      status: "active",
      ownerAccountId: accountId,
      writerAccountId: accountId,
      writerClientId: null,
      headSnapshotId: 0,
      headEventSeq: -1,
      createdAt: 1,
      updatedAt: 1,
    };
    const placement = { routingVersion: 1, generation: 7 };
    const commits = await MemoryBranchCommitStatePlane.create([
      { branch, content: "", placement },
    ]);
    const data = createMemoryRuntimeDataStore();
    const legacyAccess = jest.fn(() => {
      throw new Error("Selected local append must not access legacy storage");
    });
    const runtime = createCloudflareBackendRuntime({
      R2_BUCKET: {
        get: legacyAccess,
        head: legacyAccess,
        put: legacyAccess,
        delete: legacyAccess,
        list: legacyAccess,
      } as unknown as R2Bucket,
      DB: {
        prepare: legacyAccess,
        batch: legacyAccess,
        exec: legacyAccess,
      } as unknown as D1Database,
      localBranchApplication: { mode: "local-test", commits, placement, data },
    });
    const service = runtime.serverRuntime.nulledit;
    const contexts: NulleditSnapshotContext[] = [];
    const tasks: Promise<void>[] = [];
    const waitUntil = (task: Promise<void>) => {
      tasks.push(task);
    };
    const unsubscribe = service.registerSnapshotter({
      id: "local-runtime-registered",
      phase: "secondary",
      snapshot(context) {
        contexts.push(context);
      },
    });
    const events = [
      makeEvent({
        eventId: "local-batch-a",
        sourceClientId: "local-writer",
        text: "A",
        createdAt: 100,
        metadata: { followsSeq: -1, labels: ["batch"] },
      }),
      makeEvent({
        eventId: "local-batch-b",
        sourceClientId: "local-writer",
        text: "B",
        createdAt: 101,
        metadata: { followsSeq: 0, labels: ["batch"] },
      }),
    ];

    try {
      const accepted = await service.appendDiffEvents({
        branch,
        events,
        waitUntil,
      });
      expect(tasks).toHaveLength(1);
      await Promise.all(tasks);
      expect(accepted.content).toBe("BA");
      expect(
        accepted.acceptedEvents.map((event) => [event.seq, event.snapshotId]),
      ).toEqual([
        [0, 1],
        [1, 1],
      ]);
      expect(accepted.snapshot).toMatchObject({
        snapshotId: 1,
        parentSnapshotId: 0,
        eventIds: events.map((event) => event.eventId),
      });
      expect(contexts).toHaveLength(1);
      expect(contexts[0].data).toBe(data);
      expect(runtime.data).toBe(data);
      expect(runtime.serverRuntime.data).toBe(data);
      expect(contexts[0]).toMatchObject({
        rootDropId,
        branchId: branch.branchId,
        snapshotId: 1,
        parentSnapshotId: 0,
        acceptedEvents: accepted.acceptedEvents,
        deduplicatedCount: 0,
        totalStored: 2,
        snapshot: accepted.snapshot,
        frame: { content: "BA" },
      });
      expect(
        contexts[0].acceptedDiffRefs.map((ref) => [ref.seq, ref.snapshotId]),
      ).toEqual([
        [0, 1],
        [1, 1],
      ]);

      const replay = await service.appendDiffEvents({
        branch,
        events,
        waitUntil,
      });
      expect(replay.snapshot).toBeNull();
      expect(replay.acceptedEvents).toEqual([]);
      expect(replay.deduplicatedCount).toBe(2);
      expect(replay.acknowledgements).toEqual(
        accepted.acknowledgements.map((ack) => ({
          ...ack,
          status: "duplicate",
        })),
      );
      expect(tasks).toHaveLength(1);
      expect(contexts).toHaveLength(1);

      unsubscribe();
      const next = await service.appendDiffEvents({
        branch: accepted.branch,
        events: [
          makeEvent({
            eventId: "local-after-unsubscribe",
            sourceClientId: "local-writer",
            text: "C",
            createdAt: 102,
            metadata: { followsSeq: 1 },
          }),
        ],
        waitUntil,
      });
      expect(next.content).toBe("CBA");
      expect(next.snapshot?.snapshotId).toBe(2);
      expect(
        next.acceptedEvents.map((event) => [event.seq, event.snapshotId]),
      ).toEqual([[2, 2]]);
      expect(tasks).toHaveLength(1);
      expect(contexts).toHaveLength(1);
      const query = {
        target: { rootDropId, branchId: branch.branchId },
        placement,
      };
      const head = await commits.readHead(query);
      expect(head.version).toMatchObject({ snapshotId: 2, eventSeq: 2 });
      expect(
        (await commits.readContent({ ...query, version: head.version }))
          .content,
      ).toBe("CBA");
      await expect(
        runtime.repairBufferedCommitsForQuery(query.target),
      ).rejects.toMatchObject({ code: "capability_unsupported" });
      await expect(
        runtime.serverRuntime.memory.query(query.target),
      ).rejects.toMatchObject({ code: "capability_unsupported" });
      await expect(
        runtime.serverRuntime.memory.createFact({
          ...query.target,
          fact: { text: "Local selection must not write legacy memory" },
        }),
      ).rejects.toMatchObject({ code: "capability_unsupported" });
      expect(legacyAccess).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});

import { describe, expect, it, jest } from "@jest/globals";
import type {
  DropBranchRecord,
  DropSnapshotRecord,
} from "../../../shared/drop/branch";
import type { DropDiffEvent } from "../../../shared/drop/diff";
import {
  BranchStateError,
  type BranchBatchStatePlane,
  type BranchStateHead,
} from "../../../shared/drop/branch-state";
import { hashNulldownSourceContent } from "../../../shared/drop/resolved/hash";
import { createMemoryRuntimeDataStore } from "../memory-data-store";
import type { NulleditSnapshotContext } from "../nulledit/types";
import { createCommitApplicationStatePlane } from "./commit-application";

const branch: DropBranchRecord = {
  version: 1,
  rootDropId: "root",
  branchId: "owner",
  baseDropId: "root",
  mode: "owner",
  status: "active",
  ownerAccountId: "account",
  writerAccountId: "account",
  writerClientId: null,
  headSnapshotId: 0,
  headEventSeq: -1,
  createdAt: 1,
  updatedAt: 1,
};
const placement = { routingVersion: 1, generation: 7 };
const makeEvent = (seq: number, sourceClientId = "writer"): DropDiffEvent => ({
  eventId: `event-${seq}`,
  dropId: branch.rootDropId,
  seq,
  snapshotId: 7,
  sourceClientId,
  createdAt: seq + 10,
  ops: [{ type: "insert", start: 0, text: "A" }],
  metadata: { kind: "agent.edit", followsSeq: seq - 1, labels: ["keep-me"] },
});

const fixture = async (events: DropDiffEvent[] = []) => {
  const head: BranchStateHead = {
    target: { rootDropId: "root", branchId: "owner" },
    placement,
    branch: { ...branch, headSnapshotId: 7, headEventSeq: events.length - 1 },
    version: {
      snapshotId: 7,
      eventSeq: events.length - 1,
      sourceContentHash: await hashNulldownSourceContent("captured"),
    },
  };
  const commits = {
    append: jest.fn<BranchBatchStatePlane["append"]>(),
    appendBatch: jest.fn<BranchBatchStatePlane["appendBatch"]>(),
    readHead: jest
      .fn<BranchBatchStatePlane["readHead"]>()
      .mockImplementation(async () => structuredClone(head)),
    readContent: jest
      .fn<BranchBatchStatePlane["readContent"]>()
      .mockImplementation(async (query) => ({ ...query, content: "captured" })),
    readEvents: jest
      .fn<BranchBatchStatePlane["readEvents"]>()
      .mockImplementation(async (query) =>
        events.slice(query.startSeq, query.endSeq + 1),
      ),
  };
  const selection = { mode: "local-test" as const, commits, placement };
  return {
    head,
    commits,
    selection,
    plane: createCommitApplicationStatePlane(selection),
  };
};

describe("local commit application adapter", () => {
  it("scans exclusions across bounded chunks, counting only returned events and pinning one head", async () => {
    const events = Array.from({ length: 455 }, (_, seq) =>
      makeEvent(seq, seq === 401 || seq === 450 ? "other" : "writer"),
    );
    const { plane, commits, head } = await fixture(events);
    const captured = (await plane.branches.readBranch("root", "owner"))!;
    const version = structuredClone(head.version);
    head.version.snapshotId++;
    head.version.eventSeq++;
    const request = {
      rootDropId: "root",
      branch: captured,
      cursor: null,
      excludeClient: "writer",
      limit: 2,
      factLimit: 50,
    };
    const page = await plane.diffs.poll(request);
    expect(page).toEqual({
      response: { events: [events[401], events[450]], cursor: "450" },
      totalStored: 455,
    });
    expect(commits.readHead).toHaveBeenCalledTimes(1);
    expect(
      commits.readEvents.mock.calls.map(([query]) => [
        query.startSeq,
        query.endSeq,
      ]),
    ).toEqual([
      [0, 199],
      [200, 399],
      [400, 454],
    ]);
    for (const [query] of commits.readEvents.mock.calls)
      expect(query.version).toEqual(version);
    expect(await plane.diffs.poll({ ...request, cursor: "450" })).toEqual({
      response: { events: [], cursor: "454" },
      totalStored: 455,
    });
    expect(await plane.diffs.poll({ ...request, cursor: "454" })).toEqual({
      response: { events: [], cursor: null },
      totalStored: 455,
    });
  });

  it("retains latest handshakes, empty cursors, and original metadata without fact reads", async () => {
    const empty = await fixture();
    expect(
      await empty.plane.diffs.poll({
        rootDropId: "root",
        branch,
        cursor: "__latest__",
        limit: 50,
        factLimit: 50,
      }),
    ).toEqual({ response: { events: [], cursor: null }, totalStored: 0 });
    expect(empty.commits.readEvents).not.toHaveBeenCalled();
    const event = makeEvent(0);
    const { plane, commits } = await fixture([event]);
    expect(
      await plane.diffs.poll({
        rootDropId: "root",
        branch,
        cursor: "__latest__",
        limit: 1,
        factLimit: 1,
      }),
    ).toEqual({ response: { events: [], cursor: "0" }, totalStored: 1 });
    expect(commits.readEvents).not.toHaveBeenCalled();
    const result = await plane.diffs.poll({
      rootDropId: "root",
      branch,
      cursor: null,
      limit: 1,
      factLimit: 1,
    });
    expect(result.response.events).toEqual([event]);
    expect(result.response).not.toHaveProperty("facts");
  });

  it("reads captured content after head advancement and rejects uncaptured history without a current fallback", async () => {
    const { plane, head, commits } = await fixture();
    const captured = (await plane.branches.readBranch("root", "owner"))!;
    const version = structuredClone(head.version);
    captured.headEventSeq = 123;
    head.version.snapshotId = 8;
    head.version.eventSeq = 20;
    head.branch.headSnapshotId = 8;
    head.branch.headEventSeq = 20;
    await plane.branches.readBranch("root", "owner");
    expect(await plane.snapshots.readContent("root", "owner", 7)).toBe(
      "captured",
    );
    expect(commits.readContent).toHaveBeenCalledWith({
      target: { rootDropId: "root", branchId: "owner" },
      placement,
      version,
    });
    await expect(
      plane.snapshots.readContent("root", "owner", 6),
    ).rejects.toThrow("capability_unsupported");
    await expect(
      plane.snapshots.readContent("other", "owner", 7),
    ).rejects.toThrow("capability_unsupported");
    expect(commits.readHead).toHaveBeenCalledTimes(2);
    expect(commits.readContent).toHaveBeenCalledTimes(1);
  });

  it("maps only branch_not_found to null and propagates fencing and availability failures", async () => {
    const { commits, plane } = await fixture();
    commits.readHead.mockRejectedValueOnce(
      new BranchStateError("branch_not_found"),
    );
    expect(await plane.branches.readBranch("root", "missing")).toBeNull();
    for (const code of [
      "routing_generation_mismatch",
      "state_unavailable",
    ] as const) {
      commits.readHead.mockRejectedValueOnce(new BranchStateError(code));
      await expect(plane.branches.readBranch("root", "owner")).rejects.toThrow(
        code,
      );
    }
  });

  it("dispatches one shared batch context and isolates snapshotter, observer, and scheduler failures", async () => {
    const { commits, selection } = await fixture();
    const acceptedEvents = [makeEvent(0), makeEvent(1)];
    const snapshot: DropSnapshotRecord = {
      version: 1,
      rootDropId: "root",
      branchId: "owner",
      snapshotId: 7,
      parentSnapshotId: 6,
      seq: 1,
      eventIds: acceptedEvents.map((event) => event.eventId),
      checkpointed: true,
      textLength: 2,
      createdAt: 100,
    };
    const result = {
      branch: { ...branch, headSnapshotId: 7, headEventSeq: 1 },
      snapshot,
      content: "AA",
      acceptedEvents,
      acknowledgements: acceptedEvents.map((event) => ({
        eventId: event.eventId,
        seq: event.seq,
        snapshotId: 7,
        status: "accepted" as const,
      })),
      deduplicatedCount: 1,
      totalStored: 2,
    };
    commits.appendBatch.mockResolvedValue(result);
    const data = createMemoryRuntimeDataStore();
    const contexts: NulleditSnapshotContext[] = [];
    const failures: string[] = [];
    const tasks: Promise<void>[] = [];
    const plane = createCommitApplicationStatePlane({
      ...selection,
      data,
      snapshotters: [
        {
          id: "registered",
          phase: "primary",
          snapshot(context) {
            contexts.push(context);
            throw new Error("derived failed");
          },
        },
      ],
    });
    const events = [makeEvent(-1), makeEvent(-1), makeEvent(-1)];
    const request = {
      branch,
      events,
      snapshotters: [
        {
          id: "request",
          phase: "secondary" as const,
          snapshot(context: NulleditSnapshotContext) {
            contexts.push(context);
          },
        },
      ],
      waitUntil(task: Promise<void>) {
        tasks.push(task);
        throw new Error("scheduler failed");
      },
      onSnapshotterError(_error: unknown, id: string) {
        failures.push(id);
        throw new Error("observer failed");
      },
    };
    expect(await plane.appendDiffEvents(request)).toEqual(result);
    await Promise.all(tasks);
    expect(commits.appendBatch).toHaveBeenCalledTimes(1);
    expect(commits.appendBatch.mock.calls[0][0]).toEqual({
      target: { rootDropId: "root", branchId: "owner" },
      placement,
      events,
    });
    expect(commits.appendBatch.mock.calls[0][0].events).toBe(events);
    expect(commits.append).not.toHaveBeenCalled();
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toBe(contexts[1]);
    expect(contexts[0]).toMatchObject({
      data,
      snapshotId: 7,
      parentSnapshotId: 6,
      acceptedEvents,
      deduplicatedCount: 1,
      totalStored: 2,
      frame: { content: "AA" },
    });
    expect(
      contexts[0].acceptedDiffRefs.map((ref) => [ref.seq, ref.snapshotId]),
    ).toEqual([
      [0, 7],
      [1, 7],
    ]);
    expect(failures.sort()).toEqual(["registered", "waitUntil"]);

    commits.appendBatch.mockResolvedValue({
      ...result,
      snapshot: null,
      acceptedEvents: [],
      deduplicatedCount: 3,
    });
    await plane.appendDiffEvents(request);
    commits.appendBatch.mockResolvedValue({
      ...result,
      snapshot: null,
      acceptedEvents: [],
      deduplicatedCount: 0,
    });
    await plane.appendDiffEvents({ ...request, events: [] });
    expect(contexts).toHaveLength(2);
    expect(tasks).toHaveLength(1);
  });

  it("rejects missing derived-work data before committing and never drops registered work", async () => {
    const { commits, selection } = await fixture();
    const snapshotters = [{ id: "work", snapshot() {} }];
    const registered = createCommitApplicationStatePlane({
      ...selection,
      snapshotters,
    });
    await expect(
      registered.appendDiffEvents({ branch, events: [makeEvent(-1)] }),
    ).rejects.toThrow("capability_unsupported");
    const requested = createCommitApplicationStatePlane(selection);
    await expect(
      requested.appendDiffEvents({
        branch,
        events: [makeEvent(-1)],
        snapshotters,
      }),
    ).rejects.toThrow("capability_unsupported");
    expect(commits.appendBatch).not.toHaveBeenCalled();
  });

  it("rejects unsupported lifecycle, history, maintenance, and facts explicitly", async () => {
    const { commits, plane } = await fixture();
    const operations = [
      () => plane.branches.resolveForActor("root", "account", null),
      () => plane.branches.listBranchesForRoot("root"),
      () => plane.snapshots.readSnapshot("root", "owner", 0),
      () => plane.snapshots.listSnapshotsForBranch("root", "owner"),
      () => plane.snapshots.readContent("root", "owner", 0),
      () => plane.maintenance.listBranchesForRootPage("root", 50),
      () => plane.maintenance.backfillSnapshotHeap("root", "owner"),
      ...["-1", "__latest__", ""].map(
        (factCursor) => () =>
          plane.diffs.poll({
            rootDropId: "root",
            branch,
            cursor: "__latest__",
            limit: 50,
            factLimit: 50,
            factCursor,
          }),
      ),
    ];
    for (const operation of operations)
      await expect(operation()).rejects.toThrow("capability_unsupported");
    expect(commits.readHead).not.toHaveBeenCalled();
    expect(commits.readContent).not.toHaveBeenCalled();
    expect(commits.readEvents).not.toHaveBeenCalled();
  });

  it("chunks provenance ranges and rejects partial or out-of-order backend event ranges", async () => {
    const events = Array.from({ length: 401 }, (_, seq) => makeEvent(seq));
    const { plane, commits } = await fixture(events);
    expect(
      await plane.snapshots.readEventsBySeqRange("root", "owner", 0, 400),
    ).toEqual(events);
    expect(
      commits.readEvents.mock.calls.map(([query]) => [
        query.startSeq,
        query.endSeq,
      ]),
    ).toEqual([
      [0, 199],
      [200, 399],
      [400, 400],
    ]);
    commits.readEvents.mockResolvedValueOnce([]);
    await expect(
      plane.diffs.poll({
        rootDropId: "root",
        branch,
        cursor: null,
        limit: 50,
        factLimit: 50,
      }),
    ).rejects.toThrow("state_corrupt");
    commits.readEvents.mockResolvedValueOnce(events.slice(0, 200).reverse());
    await expect(
      plane.diffs.poll({
        rootDropId: "root",
        branch,
        cursor: null,
        limit: 50,
        factLimit: 50,
      }),
    ).rejects.toThrow("state_corrupt");
  });
});

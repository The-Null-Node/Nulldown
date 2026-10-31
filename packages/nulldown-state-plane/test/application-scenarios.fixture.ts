import type { DropDiffEvent, DropDiffOp } from "../../../shared/drop/diff";
import type { MemoryBranchStateSeed } from "../../../src/server/state-plane/memory-commits";

/** Synthetic identities shared by the local driver and fixture; never hosted roots. */
export const applicationFixture = {
  root: "Wave2Accept01",
  publicRoot: "Wave2Public01",
  branch: "fixture-writer",
  owner: "wave2-owner",
  writer: "wave2-writer",
  stranger: "wave2-stranger",
  placement: { routingVersion: 1, generation: 0 },
  initial: "# Wave2\nred blue\n",
  green: "# Wave2\ngreen blue\n",
  second: "# Wave2\ngreen blue\nclient B\n",
  batch: "Note\n# Wave2\ngreen blue\nclient B\ndone\n",
  saved: "Note\n# Wave2\ngreen blue\nclient B\ndone\nsaved\n",
  final: "Note\n# Wave2\ngreen blue\nclient B\ndone\nsaved\nlater\n",
} as const;

/** Fixture setup data; production initialization and lifecycle remain outside this test. */
export function applicationSeed(
  branchId: string = applicationFixture.branch,
  rootDropId: string = applicationFixture.root,
  content: string = applicationFixture.initial,
): MemoryBranchStateSeed {
  return {
    branch: {
      version: 1,
      rootDropId,
      baseDropId: rootDropId,
      branchId,
      mode: "owner",
      status: "active",
      ownerAccountId: applicationFixture.owner,
      writerAccountId: applicationFixture.writer,
      writerClientId: null,
      headSnapshotId: 0,
      headEventSeq: -1,
      snapshotHeapVersion: 2,
      checkpointInterval: 24,
      createdAt: 1000,
      updatedAt: 1000,
    },
    placement: { ...applicationFixture.placement },
    content,
  };
}

/** Stable synthetic wire event; retries reuse every identity field. */
export function applicationEvent(
  eventId: string,
  ops: DropDiffOp[],
  followsSeq?: number,
  sourceClientId = "client-A",
  dropId: string = applicationFixture.root,
): DropDiffEvent {
  return {
    eventId,
    seq: 0,
    dropId,
    sourceClientId,
    createdAt: 1700000000000,
    ops,
    ...(followsSeq === undefined ? {} : { metadata: { followsSeq } }),
  };
}

/** Frozen hand-authored edits and expected content, independent of server replay helpers. */
export const applicationEdits = {
  green: applicationEvent(
    "edit-green",
    [
      { type: "delete", start: 8, end: 11, text: "red" },
      { type: "insert", start: 8, end: 8, text: "green" },
    ],
    -1,
  ),
  second: applicationEvent(
    "edit-second",
    [{ type: "insert", start: 19, end: 19, text: "client B\n" }],
    0,
    "client-B",
  ),
  batch: [
    applicationEvent(
      "batch-note",
      [{ type: "insert", start: 0, end: 0, text: "Note\n" }],
      1,
    ),
    applicationEvent(
      "batch-done",
      [{ type: "insert", start: 33, end: 33, text: "done\n" }],
      2,
    ),
  ],
  saved: applicationEvent(
    "lost-ack-saved",
    [{ type: "insert", start: 38, end: 38, text: "saved\n" }],
    3,
  ),
  later: applicationEvent(
    "intervening-later",
    [{ type: "insert", start: 44, end: 44, text: "later\n" }],
    4,
    "client-B",
  ),
};

/** Bounded request evidence emitted only by the local application fixture. */
export interface ApplicationRequestEvidence {
  requestId: string;
  status: number;
  calls: Record<string, { count: number; errors: number }>;
  rpcFailures: { method: string; code: string }[];
  sqlReads: number;
  sqlWrites: number;
  background: { scheduled: number; completed: number; failed: number };
  observers: {
    id: string;
    snapshotId: number;
    parentSnapshotId: number | null;
    eventIds: string[];
    sequences: number[];
    textLength: number;
    contentHash: string;
  }[];
  observerFailures: number;
  handlerMs: number;
  totalMs: number;
}

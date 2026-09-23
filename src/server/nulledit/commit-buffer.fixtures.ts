import type {
  DropBranchRecord,
  DropSnapshotRecord,
} from "../../../shared/drop/branch";
import type { DropDiffEvent } from "../../../shared/drop/diff";
import type { BranchAcceptedCommit } from "./types";

export const rootDropId = "buffer-root";
export const branchId = "owner";

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

/** Creates an accepted commit fixture for buffer and flush-dispatch contract tests. */
export const makeCommit = (
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

import { DropDiffOperation } from "./diff-operation";
import { applyDiff } from "../nulledit/textDiff";
import { DiffOp } from "../nulledit/types";
import { hashNulldownSourceContent } from "./resolved/hash";
import {
  BranchStateError,
  sameBranchStateVersion,
  type BranchAppendRecord,
  type BranchPreparedCommit,
  type BranchStateHead,
} from "./branch-state";

/**
 * Prepares one validated append without persistence or wall-clock access.
 * Captures caller-owned command/head records synchronously before hashing.
 * Hashing is asynchronous: a durable adapter MUST recheck placement, receipt and
 * expected head in its synchronous transaction after this resolves, then commit
 * all returned rows together. This function itself grants no write authority.
 */
export const prepareBranchCommit = async (
  command: BranchAppendRecord,
  head: BranchStateHead,
  content: string,
  committedAt: number,
): Promise<BranchPreparedCommit> => {
  command = structuredClone(command);
  head = structuredClone(head);
  if (
    command.target.rootDropId !== head.target.rootDropId ||
    command.target.branchId !== head.target.branchId ||
    head.branch.rootDropId !== head.target.rootDropId ||
    head.branch.branchId !== head.target.branchId ||
    head.branch.headSnapshotId !== head.version.snapshotId ||
    head.branch.headEventSeq !== head.version.eventSeq
  ) {
    throw new BranchStateError("state_corrupt");
  }
  if (command.placement.routingVersion !== head.placement.routingVersion) {
    throw new BranchStateError("routing_version_unsupported");
  }
  if (command.placement.generation !== head.placement.generation) {
    throw new BranchStateError("routing_generation_mismatch");
  }
  if (!sameBranchStateVersion(command.expected, head.version)) {
    throw new BranchStateError("diff_predecessor_mismatch");
  }
  if (
    (await hashNulldownSourceContent(content)) !==
    head.version.sourceContentHash
  ) {
    throw new BranchStateError("state_corrupt");
  }
  if (!Number.isSafeInteger(committedAt) || committedAt < 0) {
    throw new BranchStateError("invalid_command");
  }
  const snapshotId = head.version.snapshotId + 1;
  const seq = head.version.eventSeq + 1;
  if (!Number.isSafeInteger(snapshotId) || !Number.isSafeInteger(seq + 1)) {
    throw new BranchStateError("diff_sequence_exhausted");
  }
  let nextContent = content;
  for (const op of command.event.ops) {
    const diff = DropDiffOperation.fromRecord(op).toDiff();
    if (diff.op === DiffOp.INSERT || diff.op === DiffOp.DELETE) {
      nextContent = applyDiff(nextContent, diff);
    }
  }
  const sourceContentHash = await hashNulldownSourceContent(nextContent);
  const event = { ...structuredClone(command.event), seq, snapshotId };
  const version = { snapshotId, eventSeq: seq, sourceContentHash };
  const receipt = {
    target: { ...command.target },
    placement: { ...command.placement },
    eventId: event.eventId,
    payloadHash: command.payloadHash,
    version,
  };
  return {
    branch: {
      ...head.branch,
      headSnapshotId: snapshotId,
      headEventSeq: seq,
      updatedAt: committedAt,
    },
    snapshot: {
      version: 1,
      ...command.target,
      snapshotId,
      parentSnapshotId: head.version.snapshotId,
      seq: snapshotId,
      eventIds: [event.eventId],
      checkpointed: true,
      patchStartSeq: seq,
      patchEndSeq: seq,
      textLength: nextContent.length,
      sourceContentHash,
      createdAt: committedAt,
    },
    event,
    content: nextContent,
    receipt,
    outbox: {
      id: JSON.stringify([
        "branch.commit.v1",
        command.target.rootDropId,
        command.target.branchId,
        event.eventId,
      ]),
      kind: "branch.commit.v1",
      receipt: structuredClone(receipt),
    },
  };
};

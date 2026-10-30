import type { DropDiffEvent } from "./diff";
import { DropDiffAppendEnvelopeSchema } from "./codecs/diff-v1";
import { DropDiffOperation } from "./diff-operation";
import { serializeCanonicalJson } from "./types";
import { hashNulldownSourceContent } from "./resolved/hash";
import { applyDiff } from "../nulledit/textDiff";
import { DiffOp } from "../nulledit/types";
import {
  BranchStateError,
  BranchStateQuery,
  type BranchBatchAppendRecord,
  type BranchBatchAppendResult,
  type BranchBatchCommitOutboxRecord,
  type BranchCommitReceipt,
  type BranchStateHead,
  type BranchStateVersion,
} from "./branch-state";

/** Captures and validates an envelope synchronously before routing or hashing can yield. */
export function captureBranchBatchAppend(
  input: BranchBatchAppendRecord,
): BranchBatchAppendRecord {
  if (!input || typeof input !== "object")
    throw new BranchStateError("invalid_command");
  const query = BranchStateQuery.head({
    target: input.target,
    placement: input.placement,
  });
  const parsed = DropDiffAppendEnvelopeSchema.safeParse({
    version: 1,
    events: input.events,
  });
  if (!parsed.success) throw new BranchStateError("invalid_command");
  try {
    const events = parsed.data.events.map((event) => {
      if (event.dropId !== query.target.rootDropId) throw new Error();
      const captured = {
        ...event,
        seq: -1,
        ops: event.ops.map((op) => DropDiffOperation.fromRecord(op).toRecord()),
      };
      delete captured.snapshotId;
      return captured;
    });
    return { ...query, events };
  } catch {
    throw new BranchStateError("invalid_command");
  }
}

/** Request-lifetime event identity, independent of server-assigned sequence and snapshot. */
export interface BranchBatchEventIdentity {
  event: DropDiffEvent;
  payloadHash: BranchCommitReceipt["payloadHash"];
}

/** Captures event identity before hashing, using the same domain and fields as single-event receipts. */
export async function hashBranchBatchEvents(
  events: DropDiffEvent[],
): Promise<BranchBatchEventIdentity[]> {
  const captured = structuredClone(events);
  return Promise.all(
    captured.map(async (event) => ({
      event,
      payloadHash: await hashNulldownSourceContent(
        `nulldown.branch-event.v1\n${serializeCanonicalJson({
          eventId: event.eventId,
          dropId: event.dropId,
          sourceClientId: event.sourceClientId,
          createdAt: event.createdAt,
          ops: event.ops,
          metadata: event.metadata,
        })}`,
      ),
    })),
  );
}

/** Prepared request-local publication; the owner must recheck the captured head before atomically storing it. */
export interface PreparedBranchBatch {
  result: BranchBatchAppendResult;
  version: BranchStateVersion;
  receipts: BranchCommitReceipt[];
  outbox: BranchBatchCommitOutboxRecord | null;
}

/** Prepares one public envelope against a captured authoritative head without persistence or snapshotter side effects. */
export async function prepareBranchBatch(
  command: BranchBatchAppendRecord,
  identities: BranchBatchEventIdentity[],
  head: BranchStateHead,
  content: string,
  existing: ReadonlyMap<string, BranchCommitReceipt>,
  committedAt: number,
): Promise<PreparedBranchBatch> {
  command = structuredClone(command);
  identities = structuredClone(identities);
  head = structuredClone(head);
  existing = structuredClone(existing);
  const headSeq = head.version.eventSeq;
  if (
    head.target.rootDropId !== command.target.rootDropId ||
    head.target.branchId !== command.target.branchId ||
    head.branch.rootDropId !== head.target.rootDropId ||
    head.branch.branchId !== head.target.branchId ||
    head.branch.headSnapshotId !== head.version.snapshotId ||
    head.branch.headEventSeq !== headSeq
  ) {
    throw new BranchStateError("state_corrupt");
  }
  if (head.placement.routingVersion !== command.placement.routingVersion)
    throw new BranchStateError("routing_version_unsupported");
  if (head.placement.generation !== command.placement.generation)
    throw new BranchStateError("routing_generation_mismatch");
  if (
    !Number.isSafeInteger(headSeq) ||
    headSeq < -1 ||
    headSeq >= Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(head.version.snapshotId) ||
    head.version.snapshotId < 0
  ) {
    throw new BranchStateError("diff_sequence_exhausted");
  }
  if (!Number.isSafeInteger(committedAt) || committedAt < 0)
    throw new BranchStateError("invalid_command");
  const unique = new Map<string, BranchBatchEventIdentity>();
  const accepted: BranchBatchEventIdentity[] = [];
  for (const identity of identities) {
    const id = identity.event.eventId;
    const prior = unique.get(id);
    if (prior) {
      if (prior.payloadHash !== identity.payloadHash)
        throw new BranchStateError("diff_event_id_reused");
      continue;
    }
    unique.set(id, identity);
    const receipt = existing.get(id);
    if (receipt) {
      if (receipt.payloadHash !== identity.payloadHash)
        throw new BranchStateError("diff_event_id_reused");
    } else accepted.push(identity);
  }
  for (const [index, { event }] of accepted.entries()) {
    if (
      event.metadata?.followsSeq !== undefined &&
      event.metadata.followsSeq !== headSeq + index
    ) {
      throw new BranchStateError("diff_predecessor_mismatch");
    }
  }
  if (
    (await hashNulldownSourceContent(content)) !==
    head.version.sourceContentHash
  )
    throw new BranchStateError("state_corrupt");
  const result: BranchBatchAppendResult = {
    branch: head.branch,
    snapshot: null,
    content,
    acceptedEvents: [],
    deduplicatedCount: command.events.length - accepted.length,
    totalStored: headSeq + 1,
    acknowledgements: [],
  };
  let version = head.version;
  const receipts: BranchCommitReceipt[] = [];
  let outbox: BranchBatchCommitOutboxRecord | null = null;
  if (accepted.length) {
    const snapshotId = head.version.snapshotId + 1;
    const terminalSeq = headSeq + accepted.length;
    if (
      !Number.isSafeInteger(snapshotId) ||
      !Number.isSafeInteger(terminalSeq + 1)
    )
      throw new BranchStateError("diff_sequence_exhausted");
    result.acceptedEvents = accepted.map(({ event }, index) => ({
      ...event,
      seq: headSeq + index + 1,
      snapshotId,
    }));
    for (const event of result.acceptedEvents)
      for (const op of event.ops) {
        const diff = DropDiffOperation.fromRecord(op).toDiff();
        if (diff.op === DiffOp.INSERT || diff.op === DiffOp.DELETE)
          result.content = applyDiff(result.content, diff);
      }
    version = {
      snapshotId,
      eventSeq: terminalSeq,
      sourceContentHash: await hashNulldownSourceContent(result.content),
    };
    result.branch = {
      ...head.branch,
      headSnapshotId: snapshotId,
      headEventSeq: terminalSeq,
      updatedAt: committedAt,
    };
    result.snapshot = {
      version: 1,
      ...command.target,
      snapshotId,
      parentSnapshotId: head.version.snapshotId,
      seq: snapshotId,
      eventIds: result.acceptedEvents.map((event) => event.eventId),
      checkpointed: true,
      patchStartSeq: headSeq + 1,
      patchEndSeq: terminalSeq,
      textLength: result.content.length,
      sourceContentHash: version.sourceContentHash,
      createdAt: committedAt,
    };
    result.totalStored = terminalSeq + 1;
    for (const [index, event] of result.acceptedEvents.entries())
      receipts.push({
        target: command.target,
        placement: command.placement,
        eventId: event.eventId,
        payloadHash: accepted[index].payloadHash,
        eventSeq: event.seq,
        version,
      });
    outbox = {
      id: JSON.stringify([
        "branch.batch-commit.v1",
        command.target.rootDropId,
        command.target.branchId,
        snapshotId,
      ]),
      kind: "branch.batch-commit.v1",
      target: command.target,
      placement: command.placement,
      version,
      parentSnapshotId: head.version.snapshotId,
      eventIds: result.snapshot.eventIds,
      receipts,
      deduplicated: result.deduplicatedCount,
      totalStored: result.totalStored,
    };
  }
  const newlyAccepted = new Map(
    receipts.map((receipt) => [receipt.eventId, receipt]),
  );
  result.acknowledgements = [...unique.keys()].map((eventId) => {
    const duplicate = existing.get(eventId);
    const receipt = duplicate ?? newlyAccepted.get(eventId)!;
    return {
      eventId,
      seq: receipt.eventSeq ?? receipt.version.eventSeq,
      snapshotId: receipt.version.snapshotId,
      status: duplicate ? "duplicate" : "accepted",
    };
  });
  return { result, version, receipts, outbox };
}

import type { DropSnapshotRecord } from "../../../../../shared/drop/branch";
import { type DropDiffEvent, dropDiffOpToDiff } from "../../../../../shared/drop/diff";
import { applyDiff } from "../../../../../shared/nulledit/textDiff";
import { DiffOp, type Diff } from "../../../../../shared/nulledit/types";
import type { VoidBlobStore, VoidSqlStore } from "../../../../../src/server/ports";
import { readBranchDiffEventBySeq } from "../storage/diffLogRepository";
import { readSnapshot, readSnapshotCheckpoint } from "../storage/repository";

const toEditableDiff = (op: DropDiffEvent["ops"][number]): Diff | null => {
  const converted = dropDiffOpToDiff(op);
  if (!converted) {
    return null;
  }

  if (converted.op !== DiffOp.INSERT && converted.op !== DiffOp.DELETE) {
    return null;
  }

  return converted;
};

/** Applies persisted branch diff events to a base content string. */
export const applyBranchDiffEvents = (
  baseContent: string,
  events: DropDiffEvent[],
): string => {
  let currentContent = baseContent;

  events.forEach((event) => {
    const diffs = event.ops
      .map((op) => toEditableDiff(op))
      .filter((entry): entry is Diff => Boolean(entry));
    currentContent = diffs.reduce(
      (text, diff) => applyDiff(text, diff),
      currentContent,
    );
  });

  return currentContent;
};

const readEventsBySeqRange = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
  startSeq: number,
  endSeq: number,
  db?: VoidSqlStore,
): Promise<DropDiffEvent[] | null> => {
  if (endSeq < startSeq) {
    return [];
  }

  const eventReads: Promise<DropDiffEvent | null>[] = [];
  for (let seq = startSeq; seq <= endSeq; seq += 1) {
    eventReads.push(
      readBranchDiffEventBySeq(bucket, rootDropId, branchId, seq, db),
    );
  }

  const events = await Promise.all(eventReads);
  const materialized = events
    .filter((entry): entry is DropDiffEvent => Boolean(entry))
    .sort((a, b) => a.seq - b.seq);

  const expectedCount = endSeq - startSeq + 1;
  if (materialized.length !== expectedCount) {
    return null;
  }

  return materialized;
};

/** Reads a contiguous branch event range, returning an empty list when incomplete. */
export const readBranchEventsBySeqRange = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
  startSeq: number,
  endSeq: number,
  db?: VoidSqlStore,
): Promise<DropDiffEvent[]> =>
  (await readEventsBySeqRange(bucket, rootDropId, branchId, startSeq, endSeq, db)) ?? [];

/** Rebuilds branch content for a snapshot from checkpoints and compact event ranges. */
export const readBranchContent = async (
  bucket: VoidBlobStore,
  rootDropId: string,
  branchId: string,
  snapshotId: number,
  db?: VoidSqlStore,
): Promise<string | null> => {
  const direct = await readSnapshotCheckpoint(
    bucket,
    rootDropId,
    branchId,
    snapshotId,
  );
  if (direct !== null) {
    return direct;
  }

  const targetSnapshot = await readSnapshot(
    bucket,
    rootDropId,
    branchId,
    snapshotId,
    db,
  );
  if (!targetSnapshot) {
    return null;
  }

  const replayChain: DropSnapshotRecord[] = [];
  let cursor: DropSnapshotRecord | null = targetSnapshot;
  let baseContent: string | null = null;

  while (cursor) {
    const checkpoint = await readSnapshotCheckpoint(
      bucket,
      rootDropId,
      branchId,
      cursor.snapshotId,
      cursor.checkpointKey,
    );
    if (checkpoint !== null) {
      baseContent = checkpoint;
      break;
    }

    replayChain.push(cursor);
    if (cursor.parentSnapshotId === null) {
      break;
    }

    cursor = await readSnapshot(
      bucket,
      rootDropId,
      branchId,
      cursor.parentSnapshotId,
      db,
    );
  }

  if (baseContent === null) {
    return null;
  }

  let rebuiltContent = baseContent;
  for (let index = replayChain.length - 1; index >= 0; index -= 1) {
    const snapshot = replayChain[index];

    if (
      typeof snapshot.patchStartSeq === "number" &&
      typeof snapshot.patchEndSeq === "number" &&
      snapshot.patchEndSeq >= snapshot.patchStartSeq
    ) {
      // Heap v2 snapshots prefer replaying compact event ranges over materializing every checkpoint.
      const events = await readEventsBySeqRange(
        bucket,
        rootDropId,
        branchId,
        snapshot.patchStartSeq,
        snapshot.patchEndSeq,
        db,
      );
      if (!events) {
        return null;
      }
      rebuiltContent = applyBranchDiffEvents(rebuiltContent, events);
      continue;
    }

    const fallbackCheckpoint = await readSnapshotCheckpoint(
      bucket,
      rootDropId,
      branchId,
      snapshot.snapshotId,
      snapshot.checkpointKey,
    );
    if (fallbackCheckpoint === null) {
      return null;
    }
    rebuiltContent = fallbackCheckpoint;
  }

  return rebuiltContent;
};

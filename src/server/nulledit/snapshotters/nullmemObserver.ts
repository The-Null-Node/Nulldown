import type { JsonValue, DropDiffEvent } from "../../../../shared/drop/diff";
import type { NullMemSourceRef } from "../../../../shared/nullmem/types";
import type {
  NulleditNextRequest,
  NulleditNextResult,
  NulleditNullMemObservedAppendFact,
  NulleditNullMemObserverSnapshotterOptions,
  NulleditSnapshotContext,
  NulleditSnapshotter,
} from "../types";

const nullMemObservedAppendRecordId = (
  context: NulleditSnapshotContext,
): string => {
  const firstEvent = context.acceptedEvents[0];
  const lastEvent = context.acceptedEvents[context.acceptedEvents.length - 1];
  return `memfact:observed-branch-append:${context.rootDropId}:${context.branchId}:${context.snapshotId}:${firstEvent.eventId}:${lastEvent.eventId}`;
};

const nullMemDiffSourceRef = (
  context: NulleditSnapshotContext,
  event: DropDiffEvent,
): NullMemSourceRef => ({
  kind: "diff",
  rootDropId: context.rootDropId,
  branchId: context.branchId,
  eventId: event.eventId,
  seq: event.seq,
});

const nullMemObservedAppendMetadata = (
  context: NulleditSnapshotContext,
): Record<string, JsonValue> => {
  const seqs = context.acceptedEvents.map((event) => event.seq);
  const metadata: Record<string, JsonValue> = {
    eventIds: context.acceptedEvents.map((event) => event.eventId),
    eventCount: context.acceptedEvents.length,
    snapshotId: context.snapshotId,
    parentSnapshotId: context.parentSnapshotId ?? null,
    totalStored: context.totalStored,
    deduplicatedCount: context.deduplicatedCount,
  };

  if (seqs.length) {
    metadata.seqRange = {
      from: Math.min(...seqs),
      to: Math.max(...seqs),
    };
  }

  return metadata;
};

/** Creates the built-in snapshotter that records accepted appends as NullMem facts. */
export const createNulleditNullMemObserverSnapshotter = ({
  writeFact,
}: NulleditNullMemObserverSnapshotterOptions): NulleditSnapshotter => ({
  id: "nulledit.nullmem-observer",
  phase: "secondary",
  snapshot: async (context) => {
    if (!context.acceptedEvents.length) return;

    const eventIds = context.acceptedEvents.map((event) => event.eventId);
    const fact: NulleditNullMemObservedAppendFact = {
      recordId: nullMemObservedAppendRecordId(context),
      targetKind: "snapshot",
      targetId: String(context.snapshotId),
      title: `Observed branch append snapshot ${context.snapshotId}`,
      text: `Observed branch append on ${context.rootDropId}/${context.branchId}: snapshot ${context.snapshotId} accepted ${context.acceptedEvents.length} diff event(s): ${eventIds.join(", ")}.`,
      labels: [
        "snapshotter/observable-chain",
        "nullmem/observed-append",
        "branch-append",
      ],
      priority: 1,
      confidence: 1,
      sourceRefs: [
        {
          kind: "branch",
          rootDropId: context.rootDropId,
          branchId: context.branchId,
        },
        {
          kind: "snapshot",
          rootDropId: context.rootDropId,
          branchId: context.branchId,
          snapshotId: context.snapshotId,
        },
        ...context.acceptedEvents.map((event) =>
          nullMemDiffSourceRef(context, event),
        ),
      ],
      metadata: nullMemObservedAppendMetadata(context),
    };

    await writeFact(fact, context);
  },
  yieldNext: (request?: NulleditNextRequest): NulleditNextResult => {
    // TODO: query NullMem facts for this branch with optional filters
    return { items: [] };
  },
});

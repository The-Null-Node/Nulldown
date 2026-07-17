import type { JsonValue, DropDiffEvent } from "../../../../shared/drop/diff";
import type { NullMemSourceRef } from "../../../../shared/nullmem/types";
import type {
  NulleditNextRequest,
  NulleditNextResult,
  NulleditNullMemObservedAppendFact,
  NulleditNullMemObservedProcedure,
  NulleditNullMemObserverSnapshotterOptions,
  NulleditSnapshotContext,
  NulleditSnapshotter,
} from "../types";

const procedureCandidateLabel = "nullmem/procedure-candidate";

interface ProcedureCandidate {
  goal: string;
  summary: string;
  reusableAs?: string;
}

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

const nonEmptyString = (value: JsonValue | undefined): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const jsonRecord = (
  value: JsonValue | undefined,
): Record<string, JsonValue> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;

const procedureCandidateForEvent = (
  event: DropDiffEvent,
): ProcedureCandidate | undefined => {
  if (!event.metadata?.labels?.includes(procedureCandidateLabel)) return undefined;

  const candidate = jsonRecord(event.metadata.args?.procedureCandidate);
  const goal = nonEmptyString(candidate?.goal);
  const summary = nonEmptyString(candidate?.summary);
  if (!goal || !summary || candidate?.completed !== true) return undefined;

  return {
    goal,
    summary,
    reusableAs: nonEmptyString(candidate.reusableAs),
  };
};

const nullMemObservedProcedure = (
  context: NulleditSnapshotContext,
  event: DropDiffEvent,
  candidate: ProcedureCandidate,
): NulleditNullMemObservedProcedure => {
  const diffRef = nullMemDiffSourceRef(context, event);
  const sourceSummary = nonEmptyString(event.metadata?.args?.summary);
  const intent = event.metadata?.intent?.trim();

  return {
    recordId: `memproc:auto-accepted-diff:${context.rootDropId}:${context.branchId}:${event.eventId}`,
    goal: candidate.goal,
    summary: candidate.summary,
    steps: [
      {
        index: 0,
        kind: "diff.apply",
        name: intent || "Apply accepted branch diff",
        ...(sourceSummary ? { description: sourceSummary, argsSummary: sourceSummary } : {}),
        resultSummary: `Accepted as sequence ${event.seq} in snapshot ${context.snapshotId}.`,
        status: "success",
        refs: [diffRef],
      },
    ],
    outcome: "success",
    ...(candidate.reusableAs ? { reusableAs: candidate.reusableAs } : {}),
    labels: ["procedure-memory", "auto-extracted", "needs-review", "accepted-diff"],
    priority: 1,
    confidence: Math.min(event.metadata?.confidence ?? 0.5, 0.5),
    sourceRefs: [
      {
        kind: "branch",
        rootDropId: context.rootDropId,
        branchId: context.branchId,
      },
      diffRef,
    ],
    metadata: {
      extraction: "accepted-diff-procedure-candidate",
      sourceEventId: event.eventId,
      sourceSeq: event.seq,
      acceptedSnapshotId: context.snapshotId,
    },
  };
};

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
  writeProcedure,
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

    if (!writeProcedure) return;
    for (const event of context.acceptedEvents) {
      const candidate = procedureCandidateForEvent(event);
      if (!candidate) continue;
      await writeProcedure(nullMemObservedProcedure(context, event, candidate), context);
    }
  },
  yieldNext: (request?: NulleditNextRequest): NulleditNextResult => {
    // TODO: query NullMem facts for this branch with optional filters
    return { items: [] };
  },
});

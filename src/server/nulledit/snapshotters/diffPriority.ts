import { RESOLVED_PRIORITY_FACT_RECORD_VERSION } from "../../../../shared/drop/resolved/constants";
import type { ResolvedPriorityFactRecord } from "../../../../shared/drop/resolved/types";
import type { DropDiffEvent, JsonValue } from "../../../../shared/drop/diff";
import type {
  NulleditDiffPrioritySnapshotterOptions,
  NulleditNextRequest,
  NulleditNextResult,
  NulleditSnapshotter,
} from "../types";

const priorityFromDiffMetadata = (event: DropDiffEvent): number | null => {
  const priority = event.metadata?.args?.priority;
  return typeof priority === "number" && Number.isFinite(priority)
    ? priority
    : null;
};

const priorityFactMetadata = (
  event: DropDiffEvent,
): Record<string, JsonValue> | undefined => {
  const metadata: Record<string, JsonValue> = {};
  if (event.metadata?.kind) metadata.kind = event.metadata.kind;
  if (event.metadata?.pluginId) metadata.pluginId = event.metadata.pluginId;
  if (event.metadata?.args) metadata.args = event.metadata.args;
  if (typeof event.metadata?.confidence === "number") {
    metadata.confidence = event.metadata.confidence;
  }
  if (event.metadata?.policyDecisionRef) {
    metadata.policyDecisionRef = event.metadata.policyDecisionRef;
  }
  return Object.keys(metadata).length ? metadata : undefined;
};

/** Creates the built-in snapshotter that promotes explicit diff priority metadata. */
export const createNulleditDiffPrioritySnapshotter = ({
  writePriorityFact,
}: NulleditDiffPrioritySnapshotterOptions): NulleditSnapshotter => ({
  id: "nulledit.diff-priority",
  phase: "secondary",
  snapshot: async (context) => {
    await Promise.all(
      context.acceptedEvents.map(async (event) => {
        const priority = priorityFromDiffMetadata(event);
        if (priority === null) return;

        const fact: ResolvedPriorityFactRecord = {
          version: RESOLVED_PRIORITY_FACT_RECORD_VERSION,
          factId: `priority:diff:${context.rootDropId}:${context.branchId}:${event.eventId}`,
          rootDropId: context.rootDropId,
          branchId: context.branchId,
          targetKind: "diff",
          targetId: event.eventId,
          priority,
          createdAt: event.createdAt,
          sourceSeq: event.seq,
          sourceEventId: event.eventId,
          reason: event.metadata?.intent,
          labels: event.metadata?.labels,
          metadata: priorityFactMetadata(event),
        };

        await writePriorityFact(fact, context);
      }),
    );
  },
  yieldNext: (request?: NulleditNextRequest): NulleditNextResult => {
    // TODO: query priority facts for this branch with optional filters
    return { items: [] };
  },
});

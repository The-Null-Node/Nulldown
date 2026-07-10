import { heapifyResolvedRuntimeRefs } from "../../../../shared/drop/resolved/heapify/runtimeRefs";
import {
  RESOLVED_RUNTIME_REFS_RESOLVER_ID,
  RESOLVED_RUNTIME_REFS_RESOLVER_VERSION,
} from "../../../../shared/drop/resolved/constants";
import { putResolvedDocumentState } from "../dataKeys/resolved";
import type {
  NulleditNextRequest,
  NulleditNextResult,
  NulleditResolvedRuntimeRefsSnapshotterOptions,
  NulleditSnapshotter,
} from "../types";

const sourceSeqRangeForBranch = (headEventSeq: number | null | undefined) =>
  typeof headEventSeq !== "number" || headEventSeq < 0
    ? undefined
    : { from: 0, to: headEventSeq };

/** Creates the built-in snapshotter that materializes queryable runtime-ref heaps. */
export const createNulleditResolvedRuntimeRefsSnapshotter = ({
  loadRuntimeFacts,
}: NulleditResolvedRuntimeRefsSnapshotterOptions = {}): NulleditSnapshotter => ({
  id: "nulledit.resolved-runtime-refs",
  phase: "secondary",
  snapshot: async (context) => {
    const runtimeFacts = (await loadRuntimeFacts?.(context)) ?? {};
    const state = await heapifyResolvedRuntimeRefs({
      rootDropId: context.rootDropId,
      branchId: context.branchId,
      snapshotId: context.snapshotId,
      resolverId: RESOLVED_RUNTIME_REFS_RESOLVER_ID,
      resolverVersion: RESOLVED_RUNTIME_REFS_RESOLVER_VERSION,
      sourceSeqRange: sourceSeqRangeForBranch(context.branch.headEventSeq),
      content: context.frame.content,
      uiResponseFacts: runtimeFacts.uiResponseFacts,
      uiStatePatchFacts: runtimeFacts.uiStatePatchFacts,
      uiStateSnapshots: runtimeFacts.uiStateSnapshots,
    });

    await putResolvedDocumentState(context.data, state);
  },
  yieldNext: (request?: NulleditNextRequest): NulleditNextResult => {
    // TODO: walk resolved runtime-ref heap deltas for compact projection
    return { items: [] };
  },
});

import type { DropDiffEvent } from "../../../shared/drop/diff";
import {
  changedRangesFromDropDiffEvents,
  queryResolvedDocumentNodes,
} from "../../../shared/drop/resolved/query/document";
import { heapifyResolvedDocument } from "../../../shared/drop/resolved/heapify/document";
import { hashBranchSnapshotSource } from "../../../shared/drop/resolved/hash";
import { RESOLVED_DOCUMENT_RESOLVER_ID } from "../../../shared/drop/resolved/constants";
import type { ResolvedDocumentNodeQueryResult } from "../../../shared/drop/resolved/types";

/** Immutable source captured for a resolved document query. */
export interface ResolvedDocumentQuerySource {
  rootDropId: string;
  branchId: string;
  snapshotId: number;
  headEventSeq: number;
  content: string;
  events: DropDiffEvent[];
}

/** Result preserves resolved-query identity and generated/stale semantics. */
export interface ResolvedDocumentQueryResult {
  rootDropId: string;
  branchId: string;
  snapshotId: number;
  resolverId: typeof RESOLVED_DOCUMENT_RESOLVER_ID;
  resolverVersion: string;
  sourceContentHash: string;
  stale: false;
  heapGenerated: true;
  nodeCount: number;
  nodes: ResolvedDocumentNodeQueryResult[];
}

/**
 * Rebuilds a query heap from immutable branch authority for one request. The
 * heap is deliberately ephemeral: it is a derived view, never another source
 * of truth, so cold and warm selected-storage reads have identical behavior.
 */
export const queryResolvedDocumentSource = async (
  source: ResolvedDocumentQuerySource,
  query: {
    q?: string;
    kinds?: NonNullable<
      Parameters<typeof queryResolvedDocumentNodes>[1]
    >["kinds"];
    limit?: number;
    fromSeq?: number;
    toSeq?: number;
    includeEventMetadata?: boolean;
    changedOnly?: boolean;
    includeAncestors?: boolean;
  },
): Promise<ResolvedDocumentQueryResult> => {
  const sourceContentHash = await hashBranchSnapshotSource(source);
  const state = await heapifyResolvedDocument({
    rootDropId: source.rootDropId,
    branchId: source.branchId,
    snapshotId: source.snapshotId,
    sourceSeqRange: { from: 0, to: source.headEventSeq },
    content: source.content,
  });
  const events =
    query.fromSeq !== undefined || query.toSeq !== undefined
      ? source.events.filter(
          (event) =>
            event.seq >= (query.fromSeq ?? query.toSeq ?? 0) &&
            event.seq <= (query.toSeq ?? query.fromSeq ?? 0),
        )
      : [];
  const nodes = queryResolvedDocumentNodes(state, {
    q: query.q,
    kinds: query.kinds,
    limit: query.limit,
    events: changedRangesFromDropDiffEvents(events).map((event) =>
      query.includeEventMetadata === false
        ? { ...event, metadata: undefined }
        : event,
    ),
    changedOnly: query.changedOnly,
    includeAncestors: query.includeAncestors,
  });
  return {
    rootDropId: source.rootDropId,
    branchId: source.branchId,
    snapshotId: source.snapshotId,
    resolverId: RESOLVED_DOCUMENT_RESOLVER_ID,
    resolverVersion: state.resolverVersion,
    sourceContentHash,
    stale: false,
    heapGenerated: true,
    nodeCount: state.documentNodes?.length ?? 0,
    nodes,
  };
};

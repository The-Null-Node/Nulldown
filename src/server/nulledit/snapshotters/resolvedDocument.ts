import { heapifyResolvedDocument } from "../../../../shared/drop/resolved/heapify/document";
import {
  RESOLVED_DOCUMENT_RESOLVER_ID,
  RESOLVED_DOCUMENT_RESOLVER_VERSION,
} from "../../../../shared/drop/resolved/constants";
import { putResolvedDocumentState } from "../dataKeys/resolved";
import type { NulleditSnapshotter, NulleditNextRequest, NulleditNextResult } from "../types";

const sourceSeqRangeForBranch = (headEventSeq: number | null | undefined) =>
  typeof headEventSeq !== "number" || headEventSeq < 0
    ? undefined
    : { from: 0, to: headEventSeq };

/** Creates the built-in snapshotter that materializes queryable document heaps. */
export const createNulleditResolvedDocumentSnapshotter =
  (): NulleditSnapshotter => ({
    id: "nulledit.resolved-document",
    phase: "secondary",
    snapshot: async (context) => {
      const state = await heapifyResolvedDocument({
        rootDropId: context.rootDropId,
        branchId: context.branchId,
        snapshotId: context.snapshotId,
        resolverId: RESOLVED_DOCUMENT_RESOLVER_ID,
        resolverVersion: RESOLVED_DOCUMENT_RESOLVER_VERSION,
        sourceSeqRange: sourceSeqRangeForBranch(context.branch.headEventSeq),
        content: context.frame.content,
      });

      await putResolvedDocumentState(context.data, state);
    },
    yieldNext: (request?: NulleditNextRequest): NulleditNextResult => {
      // Placeholder: real impl walks the resolved heap delta chain and returns
      // compact {id, kind, score, text: short, sourceRange} nodes.
      // MCP layer calls this for preview responses.
      return { items: [] };
    },
  });

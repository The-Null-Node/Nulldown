import { serializeCanonicalJson } from "../types";
import { RESOLVED_HEAP_DELTA_RECORD_VERSION, RESOLVED_NODE_REF_RECORD_VERSION } from "./constants";
import { hashNulldownSourceContent } from "./hash";
import type {
  CreateResolvedHeapDeltaRecordOptions,
  ResolvedHeapDeltaRecord,
  ResolvedNodeDeltaOp,
  ResolvedNodeRefRecord,
  ResolvedNulldownState,
} from "./types";

/** Builds v2 semantic node refs from the materialized nodes in a resolved state. */
export const createResolvedNodeRefRecords = async (
  state: ResolvedNulldownState,
): Promise<ResolvedNodeRefRecord[]> => {
  const nodes = [
    ...(state.documentNodes ?? []),
    ...(state.runtimeNodes ?? []),
  ];
  return Promise.all(
    nodes.map(async (node) => ({
      version: RESOLVED_NODE_REF_RECORD_VERSION,
      nodeId: node.id,
      kind: node.kind,
      nodeHash: await hashNulldownSourceContent(serializeCanonicalJson(node)),
      sourceHash: node.sourceHash,
      sourceRange: node.sourceRange,
      parentId: "parentId" in node ? node.parentId : undefined,
      text: node.text,
      importance: node.importance,
    })),
  );
};

/** Returns compact node ref operations required to transform parent refs into current refs. */
export const diffResolvedNodeRefs = (
  parentRefs: readonly ResolvedNodeRefRecord[],
  currentRefs: readonly ResolvedNodeRefRecord[],
): ResolvedNodeDeltaOp[] => {
  const parentById = new Map(parentRefs.map((ref) => [ref.nodeId, ref]));
  const currentById = new Map(currentRefs.map((ref) => [ref.nodeId, ref]));
  const ops: ResolvedNodeDeltaOp[] = [];

  for (const ref of currentRefs) {
    const previous = parentById.get(ref.nodeId);
    if (!previous || previous.nodeHash !== ref.nodeHash) {
      ops.push({ op: "upsert", ref });
    }
  }

  for (const ref of parentRefs) {
    if (!currentById.has(ref.nodeId)) {
      ops.push({
        op: "delete",
        nodeId: ref.nodeId,
        previousNodeHash: ref.nodeHash,
      });
    }
  }

  return ops;
};

/** Applies compact node ref operations over a parent ref set. */
export const applyResolvedNodeDeltaOps = (
  parentRefs: readonly ResolvedNodeRefRecord[],
  ops: readonly ResolvedNodeDeltaOp[],
): ResolvedNodeRefRecord[] => {
  const refsById = new Map(parentRefs.map((ref) => [ref.nodeId, ref]));

  for (const op of ops) {
    if (op.op === "upsert") {
      refsById.set(op.ref.nodeId, op.ref);
    } else {
      refsById.delete(op.nodeId);
    }
  }

  return [...refsById.values()];
};

/** Builds a v2 semantic heap delta record from a materialized resolved state. */
export const createResolvedHeapDeltaRecord = async ({
  state,
  parent,
  parentNodeRefs,
  diffRefs,
  priorityFactIds,
  checkpointed,
}: CreateResolvedHeapDeltaRecordOptions): Promise<ResolvedHeapDeltaRecord | null> => {
  if (!state.branchId || state.snapshotId === undefined) return null;
  const currentRefs = await createResolvedNodeRefRecords(state);
  const shouldCheckpoint = checkpointed ?? (!parent || !parentNodeRefs);
  return {
    version: RESOLVED_HEAP_DELTA_RECORD_VERSION,
    rootDropId: state.rootDropId,
    branchId: state.branchId,
    snapshotId: state.snapshotId,
    resolverId: state.resolverId,
    resolverVersion: state.resolverVersion,
    parent,
    sourceContentHash: state.sourceContentHash,
    sourceSeqRange: state.sourceSeqRange,
    resolvedAt: state.resolvedAt,
    checkpointed: shouldCheckpoint,
    nodeRefs: shouldCheckpoint ? currentRefs : undefined,
    nodeOps: shouldCheckpoint
      ? undefined
      : diffResolvedNodeRefs(parentNodeRefs ?? [], currentRefs),
    diffRefs,
    priorityFactIds,
    title: state.title,
    summary: state.summary,
  };
};

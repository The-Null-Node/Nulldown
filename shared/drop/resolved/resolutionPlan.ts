import type {
  CreateNulldownResolutionPlanOptions,
  NulldownResolutionPlan,
  NulldownResolutionPlanItem,
} from "./types";

const DEFAULT_RESOLUTION_PLAN_INLINE_LIMIT = 4096;

/**
 * Builds a deterministic deferred materialization plan from stored refs.
 *
 * The builder is intentionally pure: it orders refs, applies request-local
 * dedupe, and chooses inline mode only when the selected output is one small
 * item whose payload was already supplied by the caller.
 */
export const createNulldownResolutionPlan = ({
  rootDropId,
  branchId,
  snapshotId,
  sourceContentHash,
  resolverId,
  resolverVersion,
  items,
  inlineLimit = DEFAULT_RESOLUTION_PLAN_INLINE_LIMIT,
  dedupeBy = "hash",
}: CreateNulldownResolutionPlanOptions): NulldownResolutionPlan => {
  const selected: Array<{
    input: CreateNulldownResolutionPlanOptions["items"][number];
    output: NulldownResolutionPlanItem;
  }> = [];
  const seen = new Set<string>();
  const ordered = items
    .map((item, index) => ({ item, index }))
    .sort(
      (left, right) => left.item.order - right.item.order || left.index - right.index,
    );

  for (const { item } of ordered) {
    const dedupeKey =
      dedupeBy === "none" ? null : dedupeBy === "hash" ? item.hash : item.ref;
    if (dedupeKey) {
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
    }

    const output: NulldownResolutionPlanItem = {
      ref: item.ref,
      hash: item.hash,
      kind: item.kind,
      order: item.order,
      size: item.size,
      ...(item.sourceHash ? { sourceHash: item.sourceHash } : {}),
      ...(item.metadata ? { metadata: item.metadata } : {}),
    };
    selected.push({ input: item, output });
  }

  const sequence = selected.map(({ output }) => output);
  const base = {
    version: 1 as const,
    rootDropId,
    branchId,
    snapshotId,
    sourceContentHash,
    resolverId,
    resolverVersion,
    count: sequence.length,
    sequence,
  };

  if (selected.length === 1) {
    const [{ input, output }] = selected;
    if (output.size <= inlineLimit && input.inlineContent !== undefined) {
      return {
        ...base,
        mode: "inline",
        content: input.inlineContent,
      };
    }
  }

  return {
    ...base,
    mode: "sequence",
  };
};

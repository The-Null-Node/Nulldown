import type {
  ResolvedDocumentNode,
  ResolvedNulldownState,
  ResolvedRuntimeNode,
} from "../../../../shared/drop/resolved/types";
import type {
  VoidDataIndexEntry,
  VoidDataKey,
  VoidDataPutRecord,
  VoidDataStore,
} from "../../ports";

const resolvedSnapshotScope = (
  input: Pick<ResolvedNulldownState, "rootDropId" | "branchId" | "snapshotId">,
) => {
  if (!input.branchId || input.snapshotId === undefined) {
    throw new Error(
      "Resolved document data storage requires branchId and snapshotId.",
    );
  }
  return {
    rootDropId: input.rootDropId,
    branchId: input.branchId,
    snapshotId: input.snapshotId,
  };
};

/** Creates the portable data key for a resolved heap state record. */
export const createResolvedHeapDataKey = (
  input: Pick<
    ResolvedNulldownState,
    "rootDropId" | "branchId" | "snapshotId" | "resolverId"
  >,
): VoidDataKey => ({
  namespace: "resolved",
  collection: "heaps",
  scope: resolvedSnapshotScope(input),
  id: input.resolverId,
});

/** Creates the portable data key for one resolved document node record. */
export const createResolvedDocumentNodeDataKey = (
  state: Pick<
    ResolvedNulldownState,
    "rootDropId" | "branchId" | "snapshotId" | "resolverId"
  >,
  node: Pick<ResolvedDocumentNode, "id">,
): VoidDataKey => ({
  namespace: "resolved",
  collection: "document_nodes",
  scope: {
    ...resolvedSnapshotScope(state),
    resolverId: state.resolverId,
  },
  id: node.id,
});

/** Creates the portable data key for one resolved runtime node record. */
export const createResolvedRuntimeNodeDataKey = (
  state: Pick<
    ResolvedNulldownState,
    "rootDropId" | "branchId" | "snapshotId" | "resolverId"
  >,
  node: Pick<ResolvedRuntimeNode, "id">,
): VoidDataKey => ({
  namespace: "resolved",
  collection: "runtime_nodes",
  scope: {
    ...resolvedSnapshotScope(state),
    resolverId: state.resolverId,
  },
  id: node.id,
});

const pushOptionalIndex = (
  indexes: VoidDataIndexEntry[],
  name: string,
  value: string | number | boolean | null | undefined,
  mode: VoidDataIndexEntry["mode"] = "exact",
): void => {
  if (value !== undefined) {
    indexes.push({ name, value, mode });
  }
};

const resolvedHeapIndexes = (
  state: ResolvedNulldownState,
): VoidDataIndexEntry[] => [
  { name: "resolverId", value: state.resolverId, mode: "exact" },
  { name: "resolverVersion", value: state.resolverVersion, mode: "exact" },
  { name: "sourceContentHash", value: state.sourceContentHash, mode: "exact" },
  {
    name: "nodeCount",
    value:
      (state.documentNodes?.length ?? 0) + (state.runtimeNodes?.length ?? 0),
    mode: "range",
  },
  {
    name: "text",
    value: [state.title, state.summary].filter(Boolean).join("\n"),
    mode: "fulltext",
  },
];

const resolvedDocumentNodeIndexes = (
  node: ResolvedDocumentNode,
): VoidDataIndexEntry[] => {
  const indexes: VoidDataIndexEntry[] = [
    { name: "kind", value: node.kind, mode: "exact" },
    { name: "sourceStart", value: node.sourceRange.start, mode: "range" },
    { name: "sourceEnd", value: node.sourceRange.end, mode: "range" },
    { name: "text", value: node.text, mode: "fulltext" },
  ];
  pushOptionalIndex(indexes, "importance", node.importance, "range");
  pushOptionalIndex(indexes, "depth", node.depth, "range");
  pushOptionalIndex(indexes, "pluginId", node.pluginId);
  pushOptionalIndex(indexes, "dropId", node.dropId);
  pushOptionalIndex(indexes, "sectionId", node.sectionId);
  pushOptionalIndex(indexes, "parentId", node.parentId);
  pushOptionalIndex(indexes, "checked", node.checked);
  if (node.headingPath?.length) {
    indexes.push({
      name: "headingPath",
      value: node.headingPath,
      mode: "exact",
    });
  }
  return indexes;
};

const resolvedRuntimeNodeIndexes = (
  node: ResolvedRuntimeNode,
): VoidDataIndexEntry[] => {
  const indexes: VoidDataIndexEntry[] = [
    { name: "kind", value: node.kind, mode: "exact" },
    { name: "text", value: node.text, mode: "fulltext" },
  ];
  pushOptionalIndex(indexes, "sourceStart", node.sourceRange?.start, "range");
  pushOptionalIndex(indexes, "sourceEnd", node.sourceRange?.end, "range");
  pushOptionalIndex(indexes, "importance", node.importance, "range");
  pushOptionalIndex(indexes, "pluginId", node.pluginId);
  pushOptionalIndex(indexes, "dropId", node.dropId);
  pushOptionalIndex(indexes, "callId", node.callId);
  pushOptionalIndex(indexes, "primitiveId", node.primitiveId);
  pushOptionalIndex(indexes, "createdAt", node.createdAt, "range");
  return indexes;
};

/** Persists a resolved heap and its materialized nodes through the portable data store. */
export const putResolvedDocumentState = async (
  data: VoidDataStore,
  state: ResolvedNulldownState,
): Promise<void> => {
  const records: VoidDataPutRecord[] = [
    {
      key: createResolvedHeapDataKey(state),
      value: state,
      options: { indexes: resolvedHeapIndexes(state) },
    },
    ...(state.documentNodes ?? []).map(
      (node): VoidDataPutRecord<ResolvedDocumentNode> => ({
        key: createResolvedDocumentNodeDataKey(state, node),
        value: node,
        options: {
          indexes: resolvedDocumentNodeIndexes(node),
        },
      }),
    ),
    ...(state.runtimeNodes ?? []).map(
      (node): VoidDataPutRecord<ResolvedRuntimeNode> => ({
        key: createResolvedRuntimeNodeDataKey(state, node),
        value: node,
        options: {
          indexes: resolvedRuntimeNodeIndexes(node),
        },
      }),
    ),
  ];

  await data.putMany(records);
};

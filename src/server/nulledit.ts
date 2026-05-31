import type {
  DropBranchRecord,
  DropSnapshotRecord,
} from "../../shared/drop/branch";
import {
  createDropDiffRef,
  type DropDiffEvent,
  type DropDiffRef,
} from "../../shared/drop/diff";
import {
  RESOLVED_DOCUMENT_RESOLVER_ID,
  RESOLVED_DOCUMENT_RESOLVER_VERSION,
  heapifyResolvedDocument,
  type ResolvedDocumentNode,
  type ResolvedNulldownState,
} from "../../shared/drop/resolved";
import type { VoidDataIndexEntry, VoidDataKey, VoidDataStore } from "./ports";

/** Branch text frame passed to Nulledit snapshotters after accepted edits. */
export interface NulleditFrame {
  /** Materialized branch content for the created snapshot. */
  content: string;
}

/** Durable record written by the built-in frame snapshotter. */
export interface NulleditSnapshotFrameRecord {
  /** Record schema version. */
  version: 1;
  /** Root drop id whose branch was snapshotted. */
  rootDropId: string;
  /** Branch id that accepted the diff events. */
  branchId: string;
  /** Created snapshot id. */
  snapshotId: number;
  /** Previous branch head snapshot id. */
  parentSnapshotId: number | null;
  /** Materialized snapshot content. */
  content: string;
  /** Snapshot text length recorded by branch storage. */
  textLength: number;
  /** Stable refs to the diff events accepted into this snapshot. */
  acceptedDiffRefs: DropDiffRef[];
  /** Time the branch snapshot was created. */
  createdAt: number;
}

/** Durable record written by the built-in diff-ref snapshotter. */
export interface NulleditSnapshotDiffRefRecord {
  /** Record schema version. */
  version: 1;
  /** Root drop id whose branch was snapshotted. */
  rootDropId: string;
  /** Branch id that accepted the diff event. */
  branchId: string;
  /** Snapshot id that accepted the diff event. */
  snapshotId: number;
  /** Stable diff reference for query and snapshotter follow-up work. */
  ref: DropDiffRef;
  /** Writer client id recorded on the source event. */
  sourceClientId: string;
  /** Source event creation timestamp. */
  createdAt: number;
  /** Optional event metadata copied from the accepted diff event. */
  metadata?: DropDiffEvent["metadata"];
}

/** Context supplied to built-in and extended Nulledit snapshotters. */
export interface NulleditSnapshotContext {
  /** Functional persistence, indexing, caching, and locking boundary. */
  data: VoidDataStore;
  /** Root drop id whose branch was snapshotted. */
  rootDropId: string;
  /** Branch id that accepted the diff events. */
  branchId: string;
  /** Created snapshot id. */
  snapshotId: number;
  /** Previous branch head snapshot id. */
  parentSnapshotId: number | null;
  /** Updated branch record after the snapshot commit. */
  branch: DropBranchRecord;
  /** Snapshot record created by the append. */
  snapshot: DropSnapshotRecord;
  /** Materialized text frame for downstream snapshotters. */
  frame: NulleditFrame;
  /** Accepted diff events with durable sequence and snapshot ids assigned. */
  acceptedEvents: DropDiffEvent[];
  /** Stable refs to accepted diff events. */
  acceptedDiffRefs: DropDiffRef[];
  /** Number of input events ignored because they were duplicates. */
  deduplicatedCount: number;
  /** Total number of stored branch events after the append. */
  totalStored: number;
}

/** Phase hint for ordering Nulledit snapshotters in the append pipeline. */
export type NulleditSnapshotterPhase = "primary" | "secondary" | "extended";

/** A Nulledit snapshotter derives and stores state for an accepted snapshot. */
export interface NulleditSnapshotter {
  /** Stable snapshotter identifier used in logs and errors. */
  id: string;
  /** Optional phase hint. Snapshotters default to `extended`. */
  phase?: NulleditSnapshotterPhase;
  /** Runs after the branch snapshot has committed. */
  snapshot(context: NulleditSnapshotContext): Promise<void> | void;
}

/** Options for asynchronous Nulledit snapshotter dispatch. */
export interface NulleditSnapshotterDispatchOptions {
  /** Snapshotters registered for the created snapshot. */
  snapshotters?: NulleditSnapshotter[];
  /** Platform scheduler for work that may outlive the response. */
  waitUntil?: (promise: Promise<void>) => void;
  /** Called when a snapshotter or scheduler fails. */
  onSnapshotterError?: (error: unknown, snapshotterId: string) => void;
}

const PHASE_ORDER: Record<NulleditSnapshotterPhase, number> = {
  primary: 0,
  secondary: 1,
  extended: 2,
};

const sortSnapshotters = (
  snapshotters: NulleditSnapshotter[],
): NulleditSnapshotter[] =>
  [...snapshotters].sort(
    (left, right) =>
      PHASE_ORDER[left.phase ?? "extended"] -
      PHASE_ORDER[right.phase ?? "extended"],
  );

const snapshotScope = (context: NulleditSnapshotContext) => ({
  rootDropId: context.rootDropId,
  branchId: context.branchId,
});

const resolvedSnapshotScope = (
  input: Pick<ResolvedNulldownState, "rootDropId" | "branchId" | "snapshotId">,
) => {
  if (!input.branchId || input.snapshotId === undefined) {
    throw new Error("Resolved document data storage requires branchId and snapshotId.");
  }
  return {
    rootDropId: input.rootDropId,
    branchId: input.branchId,
    snapshotId: input.snapshotId,
  };
};

/** Creates the portable data key for a resolved heap state record. */
export const createResolvedHeapDataKey = (
  input: Pick<ResolvedNulldownState, "rootDropId" | "branchId" | "snapshotId" | "resolverId">,
): VoidDataKey => ({
  namespace: "resolved",
  collection: "heaps",
  scope: resolvedSnapshotScope(input),
  id: input.resolverId,
});

/** Creates the portable data key for one resolved document node record. */
export const createResolvedDocumentNodeDataKey = (
  state: Pick<ResolvedNulldownState, "rootDropId" | "branchId" | "snapshotId" | "resolverId">,
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

const resolvedHeapIndexes = (state: ResolvedNulldownState): VoidDataIndexEntry[] => [
  { name: "resolverId", value: state.resolverId, mode: "exact" },
  { name: "resolverVersion", value: state.resolverVersion, mode: "exact" },
  { name: "sourceContentHash", value: state.sourceContentHash, mode: "exact" },
  { name: "nodeCount", value: state.documentNodes?.length ?? 0, mode: "range" },
  { name: "text", value: [state.title, state.summary].filter(Boolean).join("\n"), mode: "fulltext" },
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
    indexes.push({ name: "headingPath", value: node.headingPath, mode: "exact" });
  }
  return indexes;
};

/** Persists a resolved document heap and its nodes through the portable data store. */
export const putResolvedDocumentState = async (
  data: VoidDataStore,
  state: ResolvedNulldownState,
): Promise<void> => {
  await data.put(createResolvedHeapDataKey(state), state, {
    indexes: resolvedHeapIndexes(state),
  });

  await Promise.all(
    (state.documentNodes ?? []).map((node) =>
      data.put(createResolvedDocumentNodeDataKey(state, node), node, {
        indexes: resolvedDocumentNodeIndexes(node),
      }),
    ),
  );
};

/** Creates the built-in snapshotter that persists materialized snapshot frames. */
export const createNulleditFrameSnapshotter = (): NulleditSnapshotter => ({
  id: "nulledit.frame",
  phase: "secondary",
  snapshot: async (context) => {
    const record: NulleditSnapshotFrameRecord = {
      version: 1,
      rootDropId: context.rootDropId,
      branchId: context.branchId,
      snapshotId: context.snapshotId,
      parentSnapshotId: context.parentSnapshotId,
      content: context.frame.content,
      textLength: context.snapshot.textLength,
      acceptedDiffRefs: context.acceptedDiffRefs,
      createdAt: context.snapshot.createdAt,
    };

    await context.data.put<NulleditSnapshotFrameRecord>(
      {
        namespace: "nulledit",
        collection: "snapshot_frames",
        scope: snapshotScope(context),
        id: String(context.snapshotId),
      },
      record,
      {
        indexes: [
          { name: "snapshotId", value: context.snapshotId, mode: "exact" },
          { name: "textLength", value: context.snapshot.textLength, mode: "range" },
        ],
      },
    );
  },
});

/** Creates the built-in snapshotter that persists accepted diff refs for the snapshot. */
export const createNulleditDiffRefSnapshotter = (): NulleditSnapshotter => ({
  id: "nulledit.diff-refs",
  phase: "secondary",
  snapshot: async (context) => {
    await Promise.all(
      context.acceptedEvents.map((event) => {
        const ref = createDropDiffRef({
          rootDropId: context.rootDropId,
          branchId: context.branchId,
          seq: event.seq,
          eventId: event.eventId,
          snapshotId: event.snapshotId,
        });
        const record: NulleditSnapshotDiffRefRecord = {
          version: 1,
          rootDropId: context.rootDropId,
          branchId: context.branchId,
          snapshotId: context.snapshotId,
          ref,
          sourceClientId: event.sourceClientId,
          createdAt: event.createdAt,
          metadata: event.metadata,
        };

        return context.data.put<NulleditSnapshotDiffRefRecord>(
          {
            namespace: "nulledit",
            collection: "snapshot_diff_refs",
            scope: {
              ...snapshotScope(context),
              snapshotId: context.snapshotId,
            },
            id: event.eventId,
          },
          record,
          {
            indexes: [
              { name: "eventId", value: event.eventId, mode: "exact" },
              { name: "seq", value: event.seq, mode: "range" },
              { name: "sourceClientId", value: event.sourceClientId, mode: "exact" },
              ...(event.metadata?.kind
                ? [{ name: "kind", value: event.metadata.kind, mode: "exact" as const }]
                : []),
              ...(event.metadata?.labels?.length
                ? [{ name: "labels", value: event.metadata.labels, mode: "exact" as const }]
                : []),
            ],
          },
        );
      }),
    );
  },
});

/** Creates the built-in snapshotter that materializes queryable document heaps. */
export const createNulleditResolvedDocumentSnapshotter = (): NulleditSnapshotter => ({
  id: "nulledit.resolved-document",
  phase: "secondary",
  snapshot: async (context) => {
    const state = await heapifyResolvedDocument({
      rootDropId: context.rootDropId,
      branchId: context.branchId,
      snapshotId: context.snapshotId,
      resolverId: RESOLVED_DOCUMENT_RESOLVER_ID,
      resolverVersion: RESOLVED_DOCUMENT_RESOLVER_VERSION,
      sourceSeqRange:
        typeof context.branch.headEventSeq !== "number" || context.branch.headEventSeq < 0
          ? undefined
          : { from: 0, to: context.branch.headEventSeq },
      content: context.frame.content,
    });

    await putResolvedDocumentState(context.data, state);
  },
});

/** Creates the built-in Nulledit snapshotters registered by provider adapters. */
export const createBuiltInNulleditSnapshotters = (): NulleditSnapshotter[] => [
  createNulleditFrameSnapshotter(),
  createNulleditDiffRefSnapshotter(),
  createNulleditResolvedDocumentSnapshotter(),
];

/** Dispatches Nulledit snapshotters after a snapshot commit without blocking callers. */
export const dispatchNulleditSnapshotters = (
  context: NulleditSnapshotContext,
  options?: NulleditSnapshotterDispatchOptions,
): void => {
  const snapshotters = sortSnapshotters(options?.snapshotters ?? []);
  if (!snapshotters.length) {
    return;
  }

  const task = Promise.all(
    snapshotters.map(async (snapshotter) => {
      try {
        await snapshotter.snapshot(context);
      } catch (error) {
        options?.onSnapshotterError?.(error, snapshotter.id);
      }
    }),
  ).then(() => undefined);

  if (options?.waitUntil) {
    try {
      options.waitUntil(task);
      return;
    } catch (error) {
      options.onSnapshotterError?.(error, "waitUntil");
    }
  }

  void task;
};

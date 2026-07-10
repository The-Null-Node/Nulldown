import { parseJsonColumn } from "../../core/d1/metadata";
import { RESOLVED_RUNTIME_REFS_RESOLVER_ID } from "../../../../../shared/drop/resolved/constants";
import {
  applyResolvedNodeDeltaOps,
  createResolvedHeapDeltaRecord,
  createResolvedNodeRefRecords,
} from "../../../../../shared/drop/resolved/nodeRefs";
import type {
  ResolvedDocumentNode,
  ResolvedDocumentNodeKind,
  ResolvedHeapDeltaRecord,
  ResolvedHeapRef,
  ResolvedNulldownState,
  ResolvedNodeRefRecord,
  ResolvedRuntimeNode,
  ResolvedRuntimeNodeKind,
} from "../../../../../shared/drop/resolved/types";
import {
  isResolvedHeapDeltaRecord,
  isResolvedNulldownState,
  isResolvedNodeRefRecord,
} from "../../../../../shared/drop/resolved/validators";
import type { VoidSqlStore } from "../../../../../src/server/ports";

const RESOLVED_HEAP_CHECKPOINT_INTERVAL = 24;
const RESOLVED_HEAP_MAX_DELTA_DEPTH = 64;

const DOCUMENT_NODE_KINDS = new Set<ResolvedDocumentNodeKind>([
  "document.title",
  "section",
  "heading",
  "paragraph",
  "list.item",
  "checklist.item",
  "code.block",
  "nullplug.ref",
  "link.ref",
  "diff.region",
]);

const RUNTIME_NODE_KINDS = new Set<ResolvedRuntimeNodeKind>([
  "nullplug.ref",
  "ui.primitive",
  "ui.state",
  "ui.response",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isResolvedSourceRangeProjection = (
  value: unknown,
): value is { start: number; end: number } => {
  if (!isRecord(value)) return false;
  return isNonNegativeInteger(value.start) && isNonNegativeInteger(value.end);
};

const isResolvedDocumentNodeProjection = (
  value: unknown,
): value is ResolvedDocumentNode => {
  if (!isRecord(value)) return false;
  if (
    !isString(value.id) ||
    !DOCUMENT_NODE_KINDS.has(value.kind as ResolvedDocumentNodeKind)
  ) {
    return false;
  }
  if (!isString(value.text) || !isString(value.sourceHash)) return false;
  if (!isResolvedSourceRangeProjection(value.sourceRange)) return false;
  return true;
};

const isResolvedRuntimeNodeProjection = (
  value: unknown,
): value is ResolvedRuntimeNode => {
  if (!isRecord(value)) return false;
  if (
    !isString(value.id) ||
    !RUNTIME_NODE_KINDS.has(value.kind as ResolvedRuntimeNodeKind)
  ) {
    return false;
  }
  if (!isString(value.text) || !isString(value.sourceHash)) return false;
  if (
    value.sourceRange !== undefined &&
    !isResolvedSourceRangeProjection(value.sourceRange)
  ) {
    return false;
  }
  return true;
};

/** Ports used by compact resolved heap projection repositories. */
export interface ResolvedHeapProjectionRepositoryPorts {
  /** Optional SQL metadata store containing resolved heap projection rows. */
  sql?: VoidSqlStore;
}

/** Repository for compact resolved heap state, node payload, and delta rows. */
export interface ResolvedHeapProjectionRepository {
  /** Reads a resolved heap state from compact D1 projections when available. */
  readState(
    rootDropId: string,
    branchId: string,
    resolverId: string,
    snapshotId: number,
  ): Promise<ResolvedNulldownState | null>;
  /** Synchronizes one resolved heap state into compact D1 projection rows. */
  syncState(state: ResolvedNulldownState): Promise<void>;
}

const readResolvedNodeRefsFromD1 = async (
  db: VoidSqlStore,
  target: ResolvedHeapRef,
): Promise<ResolvedNodeRefRecord[] | null> => {
  const { results = [] } = await db
    .prepare(
      `SELECT ref_json
       FROM resolved_node_refs
       WHERE root_drop_id = ? AND branch_id = ? AND snapshot_id = ? AND resolver_id = ?`,
    )
    .bind(
      target.rootDropId,
      target.branchId,
      target.snapshotId,
      target.resolverId,
    )
    .all<{ ref_json: string }>();

  const refs = results.map((row) =>
    parseJsonColumn(row.ref_json, isResolvedNodeRefRecord),
  );
  if (refs.some((ref) => ref === null)) return null;
  return refs as ResolvedNodeRefRecord[];
};

const readResolvedHeapDeltaFromD1 = async (
  db: VoidSqlStore,
  rootDropId: string,
  branchId: string,
  resolverId: string,
  snapshotId: number,
): Promise<ResolvedHeapDeltaRecord | null> => {
  const row = await db
    .prepare(
      `SELECT heap_delta_json
       FROM resolved_heap_deltas
       WHERE root_drop_id = ? AND branch_id = ? AND snapshot_id = ? AND resolver_id = ?`,
    )
    .bind(rootDropId, branchId, snapshotId, resolverId)
    .first<{ heap_delta_json: string }>();
  return parseJsonColumn(row?.heap_delta_json, isResolvedHeapDeltaRecord);
};

const resolveResolvedNodeRefsFromD1 = async (
  db: VoidSqlStore,
  target: ResolvedHeapRef,
): Promise<ResolvedNodeRefRecord[] | null> => {
  const chain: ResolvedHeapDeltaRecord[] = [];
  const seen = new Set<string>();
  let current: ResolvedHeapRef | undefined = target;

  while (current) {
    const key = `${current.rootDropId}/${current.branchId}/${current.snapshotId}/${current.resolverId}`;
    if (seen.has(key) || chain.length >= RESOLVED_HEAP_MAX_DELTA_DEPTH) {
      return null;
    }
    seen.add(key);

    const delta = await readResolvedHeapDeltaFromD1(
      db,
      current.rootDropId,
      current.branchId,
      current.resolverId,
      current.snapshotId,
    );
    if (!delta) return null;
    chain.push(delta);
    if (delta.checkpointed) break;
    current = delta.parent;
  }

  if (chain.length === 0) return null;
  const checkpoint = chain[chain.length - 1];
  if (!checkpoint.checkpointed) return null;
  const checkpointRefs =
    checkpoint.nodeRefs ?? (await readResolvedNodeRefsFromD1(db, checkpoint));
  if (!checkpointRefs) return null;

  let refs = checkpointRefs;
  for (const delta of chain.slice(0, -1).reverse()) {
    if (!delta.nodeOps) return null;
    refs = applyResolvedNodeDeltaOps(refs, delta.nodeOps);
  }

  return refs;
};

const readResolvedNodePayloadFromD1 = async (
  db: VoidSqlStore,
  nodeHash: string,
  resolverId: string,
): Promise<ResolvedDocumentNode | ResolvedRuntimeNode | null> => {
  const row = await db
    .prepare(
      `SELECT node_json
       FROM resolved_node_payloads
       WHERE node_hash = ?`,
    )
    .bind(nodeHash)
    .first<{ node_json: string }>();
  if (resolverId === RESOLVED_RUNTIME_REFS_RESOLVER_ID) {
    return parseJsonColumn(row?.node_json, isResolvedRuntimeNodeProjection);
  }
  return parseJsonColumn(row?.node_json, isResolvedDocumentNodeProjection);
};

const hydrateResolvedNodesFromPayloads = async (
  db: VoidSqlStore,
  refs: readonly ResolvedNodeRefRecord[],
  resolverId: string,
): Promise<Array<ResolvedDocumentNode | ResolvedRuntimeNode> | null> => {
  const nodes: Array<ResolvedDocumentNode | ResolvedRuntimeNode> = [];
  for (const ref of refs) {
    const node = await readResolvedNodePayloadFromD1(
      db,
      ref.nodeHash,
      resolverId,
    );
    if (!node) return null;
    nodes.push(node);
  }
  return nodes;
};

const hydrateResolvedNodesFromProjection = async (
  db: VoidSqlStore,
  target: ResolvedHeapRef,
  refs: readonly ResolvedNodeRefRecord[],
): Promise<Array<ResolvedDocumentNode | ResolvedRuntimeNode> | null> => {
  const refIds = new Set(refs.map((ref) => ref.nodeId));
  const { results = [] } = await db
    .prepare(
      `SELECT node_id, node_json
       FROM resolved_nodes
       WHERE root_drop_id = ? AND branch_id = ? AND snapshot_id = ? AND resolver_id = ?`,
    )
    .bind(
      target.rootDropId,
      target.branchId,
      target.snapshotId,
      target.resolverId,
    )
    .all<{ node_id: string; node_json: string }>();

  const nodes: Array<ResolvedDocumentNode | ResolvedRuntimeNode> = [];
  const seen = new Set<string>();
  for (const row of results) {
    if (!refIds.has(row.node_id)) continue;
    const node =
      target.resolverId === RESOLVED_RUNTIME_REFS_RESOLVER_ID
        ? parseJsonColumn(row.node_json, isResolvedRuntimeNodeProjection)
        : parseJsonColumn(row.node_json, isResolvedDocumentNodeProjection);
    if (!node) return null;
    seen.add(row.node_id);
    nodes.push(node);
  }

  return seen.size === refIds.size ? nodes : null;
};

const materializeResolvedStateFromD1Delta = async (
  db: VoidSqlStore,
  delta: ResolvedHeapDeltaRecord,
): Promise<ResolvedNulldownState | null> => {
  const refs = await resolveResolvedNodeRefsFromD1(db, delta);
  if (!refs) return null;
  const payloadNodes = await hydrateResolvedNodesFromPayloads(
    db,
    refs,
    delta.resolverId,
  );
  const nodes =
    payloadNodes ?? (await hydrateResolvedNodesFromProjection(db, delta, refs));
  if (!nodes) return null;
  const documentNodes = nodes as ResolvedDocumentNode[];
  const runtimeNodes = nodes as ResolvedRuntimeNode[];

  return {
    version: 1,
    id: `resolved:${delta.rootDropId}:${delta.branchId}:${delta.snapshotId}:${delta.resolverId}`,
    rootDropId: delta.rootDropId,
    branchId: delta.branchId,
    snapshotId: delta.snapshotId,
    sourceSeqRange: delta.sourceSeqRange,
    sourceContentHash: delta.sourceContentHash,
    resolverId: delta.resolverId,
    resolverVersion: delta.resolverVersion,
    resolvedAt: delta.resolvedAt,
    title: delta.title,
    summary: delta.summary,
    documentNodes:
      delta.resolverId === RESOLVED_RUNTIME_REFS_RESOLVER_ID
        ? undefined
        : documentNodes,
    runtimeNodes:
      delta.resolverId === RESOLVED_RUNTIME_REFS_RESOLVER_ID
        ? runtimeNodes
        : undefined,
  };
};

const readResolvedStateFromD1Delta = async (
  db: VoidSqlStore,
  rootDropId: string,
  branchId: string,
  resolverId: string,
  snapshotId: number,
): Promise<ResolvedNulldownState | null> => {
  const delta = await readResolvedHeapDeltaFromD1(
    db,
    rootDropId,
    branchId,
    resolverId,
    snapshotId,
  );
  if (!delta) return null;
  return materializeResolvedStateFromD1Delta(db, delta);
};

const readResolvedStateSnapshotFromD1 = async (
  db: VoidSqlStore,
  rootDropId: string,
  branchId: string,
  resolverId: string,
  snapshotId: number,
): Promise<ResolvedNulldownState | null> => {
  const row = await db
    .prepare(
      `SELECT state_json
         FROM resolved_heaps
         WHERE root_drop_id = ? AND branch_id = ? AND snapshot_id = ? AND resolver_id = ?`,
    )
    .bind(rootDropId, branchId, snapshotId, resolverId)
    .first<{ state_json: string }>();
  return parseJsonColumn(row?.state_json, isResolvedNulldownState);
};

const syncResolvedNodesToD1 = async (
  db: VoidSqlStore | undefined,
  state: ResolvedNulldownState,
): Promise<void> => {
  if (!db || !state.branchId || state.snapshotId === undefined) return;

  await db
    .prepare(
      `DELETE FROM resolved_nodes
       WHERE root_drop_id = ? AND branch_id = ? AND snapshot_id = ? AND resolver_id = ?`,
    )
    .bind(state.rootDropId, state.branchId, state.snapshotId, state.resolverId)
    .run();

  const nodes = [...(state.documentNodes ?? []), ...(state.runtimeNodes ?? [])];
  for (const node of nodes) {
    await db
      .prepare(
        `INSERT INTO resolved_nodes (
           root_drop_id, branch_id, snapshot_id, resolver_id, node_id,
           kind, source_start, source_end, text, importance, node_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(root_drop_id, branch_id, snapshot_id, resolver_id, node_id)
          DO UPDATE SET
            kind = excluded.kind,
            source_start = excluded.source_start,
            source_end = excluded.source_end,
            text = excluded.text,
            importance = excluded.importance,
            node_json = excluded.node_json`,
      )
      .bind(
        state.rootDropId,
        state.branchId,
        state.snapshotId,
        state.resolverId,
        node.id,
        node.kind,
        node.sourceRange?.start ?? null,
        node.sourceRange?.end ?? null,
        node.text,
        node.importance ?? null,
        JSON.stringify(node),
      )
      .run();
  }
};

const syncResolvedNodeRefsToD1 = async (
  db: VoidSqlStore,
  delta: ResolvedHeapDeltaRecord,
  nodeRefs: readonly ResolvedNodeRefRecord[],
): Promise<void> => {
  await db
    .prepare(
      `DELETE FROM resolved_node_refs
       WHERE root_drop_id = ? AND branch_id = ? AND snapshot_id = ? AND resolver_id = ?`,
    )
    .bind(delta.rootDropId, delta.branchId, delta.snapshotId, delta.resolverId)
    .run();

  for (const nodeRef of nodeRefs) {
    await writeResolvedNodeRefToD1(db, delta, nodeRef);
  }
};

const writeResolvedNodeRefToD1 = async (
  db: VoidSqlStore,
  delta: ResolvedHeapDeltaRecord,
  nodeRef: ResolvedNodeRefRecord,
): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO resolved_node_refs (
          root_drop_id, branch_id, snapshot_id, resolver_id, node_id,
          kind, node_hash, source_hash, source_start, source_end,
          parent_node_id, importance, ref_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(root_drop_id, branch_id, snapshot_id, resolver_id, node_id)
        DO UPDATE SET
          kind = excluded.kind,
          node_hash = excluded.node_hash,
          source_hash = excluded.source_hash,
          source_start = excluded.source_start,
          source_end = excluded.source_end,
          parent_node_id = excluded.parent_node_id,
          importance = excluded.importance,
          ref_json = excluded.ref_json`,
    )
    .bind(
      delta.rootDropId,
      delta.branchId,
      delta.snapshotId,
      delta.resolverId,
      nodeRef.nodeId,
      nodeRef.kind,
      nodeRef.nodeHash,
      nodeRef.sourceHash,
      nodeRef.sourceRange?.start ?? null,
      nodeRef.sourceRange?.end ?? null,
      nodeRef.parentId ?? null,
      nodeRef.importance ?? null,
      JSON.stringify(nodeRef),
    )
    .run();
};

const writeResolvedNodePayloadsToD1 = async (
  db: VoidSqlStore,
  state: ResolvedNulldownState,
  nodeRefs: readonly ResolvedNodeRefRecord[],
): Promise<void> => {
  const nodes = [...(state.documentNodes ?? []), ...(state.runtimeNodes ?? [])];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  for (const ref of nodeRefs) {
    const node = nodeById.get(ref.nodeId);
    if (!node) continue;
    await db
      .prepare(
        `INSERT OR IGNORE INTO resolved_node_payloads (
           node_hash, kind, source_hash, source_start, source_end, text,
           first_seen_at, node_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        ref.nodeHash,
        ref.kind,
        ref.sourceHash,
        ref.sourceRange?.start ?? null,
        ref.sourceRange?.end ?? null,
        ref.text ?? node.text,
        state.resolvedAt,
        JSON.stringify(node),
      )
      .run();
  }
};

const shouldCheckpointResolvedHeap = (
  snapshotId: number,
  parentResolved: boolean,
): boolean =>
  snapshotId === 0 ||
  !parentResolved ||
  snapshotId % RESOLVED_HEAP_CHECKPOINT_INTERVAL === 0;

const syncResolvedHeapDeltaToD1 = async (
  db: VoidSqlStore | undefined,
  state: ResolvedNulldownState,
): Promise<void> => {
  if (!db || !state.branchId || state.snapshotId === undefined) return;
  const parent =
    state.snapshotId > 0
      ? {
          rootDropId: state.rootDropId,
          branchId: state.branchId,
          snapshotId: state.snapshotId - 1,
          resolverId: state.resolverId,
        }
      : undefined;
  const parentNodeRefs = parent
    ? await resolveResolvedNodeRefsFromD1(db, parent).catch(() => null)
    : null;
  const currentNodeRefs = await createResolvedNodeRefRecords(state);
  const delta = await createResolvedHeapDeltaRecord({
    state,
    parent,
    parentNodeRefs: parentNodeRefs ?? undefined,
    checkpointed: shouldCheckpointResolvedHeap(
      state.snapshotId,
      !parent || parentNodeRefs !== null,
    ),
  });
  if (!delta) return;

  await writeResolvedNodePayloadsToD1(db, state, currentNodeRefs);

  await db
    .prepare(
      `INSERT INTO resolved_heap_deltas (
         root_drop_id, branch_id, snapshot_id, resolver_id, resolver_version,
         parent_snapshot_id, parent_resolver_id, source_content_hash,
         source_seq_from, source_seq_to, resolved_at, checkpointed, heap_delta_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(root_drop_id, branch_id, snapshot_id, resolver_id) DO UPDATE SET
         resolver_version = excluded.resolver_version,
         parent_snapshot_id = excluded.parent_snapshot_id,
         parent_resolver_id = excluded.parent_resolver_id,
         source_content_hash = excluded.source_content_hash,
         source_seq_from = excluded.source_seq_from,
         source_seq_to = excluded.source_seq_to,
         resolved_at = excluded.resolved_at,
         checkpointed = excluded.checkpointed,
         heap_delta_json = excluded.heap_delta_json`,
    )
    .bind(
      delta.rootDropId,
      delta.branchId,
      delta.snapshotId,
      delta.resolverId,
      delta.resolverVersion,
      delta.parent?.snapshotId ?? null,
      delta.parent?.resolverId ?? null,
      delta.sourceContentHash,
      delta.sourceSeqRange?.from ?? null,
      delta.sourceSeqRange?.to ?? null,
      delta.resolvedAt,
      delta.checkpointed ? 1 : 0,
      JSON.stringify(delta),
    )
    .run();
  await syncResolvedNodeRefsToD1(db, delta, currentNodeRefs);
};

/** Writes compact resolved heap projections into D1 without touching R2 blobs. */
export const syncResolvedStateToD1 = async (
  db: VoidSqlStore | undefined,
  state: ResolvedNulldownState,
): Promise<void> => {
  if (!db || !state.branchId || state.snapshotId === undefined) return;

  await syncResolvedNodesToD1(db, state);
  await syncResolvedHeapDeltaToD1(db, state);
};

/** Creates a compact resolved heap projection repository bound to SQL ports. */
export const createResolvedHeapProjectionRepository = ({
  sql,
}: ResolvedHeapProjectionRepositoryPorts): ResolvedHeapProjectionRepository => ({
  readState: async (rootDropId, branchId, resolverId, snapshotId) => {
    if (!sql) return null;
    const deltaState = await readResolvedStateFromD1Delta(
      sql,
      rootDropId,
      branchId,
      resolverId,
      snapshotId,
    );
    return (
      deltaState ??
      (await readResolvedStateSnapshotFromD1(
        sql,
        rootDropId,
        branchId,
        resolverId,
        snapshotId,
      ))
    );
  },
  syncState: (state) => syncResolvedStateToD1(sql, state),
});

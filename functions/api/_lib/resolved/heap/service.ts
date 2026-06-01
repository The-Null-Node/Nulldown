import { readBranchContent, readBranchEventsBySeqRange } from "../../branches/content/replay";
import { readBranch } from "../../branches/storage/repository";
import {
  resolveAuthenticatedAccountId,
  type AccountAuthEnv,
} from "../../accounts/session/auth";
import { sanitizeDiffAuthToken } from "../../diffs/credentials/repository";
import { resolveRemoteDropId } from "../../drops/identity/id";
import {
  apiHttpErrorResponse,
  isApiHttpError,
  jsonErrorResponse,
  jsonResponse,
  readRequestTextWithLimit,
  resolveParam,
  type JsonValue,
} from "../../core/http/responses";
import { listNullplugRuntimeFacts } from "../../nullplug/facts/repository";
import {
  RESOLVED_PRIORITY_FACT_RECORD_VERSION,
  RESOLVED_DOCUMENT_RESOLVER_ID,
  RESOLVED_RUNTIME_REFS_RESOLVER_ID,
  applyResolvedNodeDeltaOps,
  changedRangesFromDropDiffEvents,
  createResolvedHeapDeltaRecord,
  createResolvedNodeRefRecords,
  hashBranchSnapshotSource,
  heapifyResolvedDocument,
  heapifyResolvedRuntimeRefs,
  isResolvedHeapDeltaRecord,
  isResolvedNulldownState,
  isResolvedNodeRefRecord,
  isResolvedPriorityFactRecord,
  queryResolvedDocumentNodes,
  queryResolvedRuntimeNodes,
  readResolvedNulldownState,
  writeResolvedNulldownState,
  type ResolvedDocumentNode,
  type ResolvedDocumentNodeKind,
  type ResolvedHeapDeltaRecord,
  type ResolvedHeapRef,
  type ResolvedNulldownState,
  type ResolvedNodeRefRecord,
  type ResolvedPriorityFactRecord,
  type ResolvedRuntimeNode,
  type ResolvedRuntimeNodeKind,
} from "../../../../../shared/drop/resolved";
import {
  isNullplugUiPrimitive,
  isNullplugUiResponseFact,
  isNullplugUiStatePatchFact,
  isNullplugUiStateSnapshot,
  type NullplugUiPrimitive,
  type NullplugUiResponseFact,
  type NullplugUiStatePatchFact,
  type NullplugUiStateSnapshot,
} from "../../../../../shared/nullplug/ui";
import { parseJsonColumn } from "../../core/d1/metadata";
import type { VoidBlobStore, VoidSqlStore } from "../../../../../src/server/ports";

/** Environment required by resolved heap route services. */
export interface ResolvedHeapEnv extends AccountAuthEnv {
  R2_BUCKET: VoidBlobStore;
  DB?: VoidSqlStore;
}

/** Route parameters for branch resolved heap operations. */
export interface ResolvedHeapParams {
  rootId: string | string[];
  branchId: string | string[];
}

interface ResolvedUpdateRequest {
  resolverId?:
    | typeof RESOLVED_DOCUMENT_RESOLVER_ID
    | typeof RESOLVED_RUNTIME_REFS_RESOLVER_ID
    | "all";
  snapshotId?: number | "latest";
  uiPrimitives?: NullplugUiPrimitive[];
  uiResponseFacts?: NullplugUiResponseFact[];
  uiStatePatchFacts?: NullplugUiStatePatchFact[];
  uiStateSnapshots?: NullplugUiStateSnapshot[];
}

interface ResolvedPriorityFactRequest {
  factId?: string;
  resolverId?: string;
  targetKind?: ResolvedPriorityFactRecord["targetKind"];
  targetId?: string;
  priority?: number;
  sourceSeq?: number;
  sourceEventId?: string;
  reason?: string;
  labels?: string[];
  metadata?: Record<string, unknown>;
}

const RESOLVED_UPDATE_BODY_MAX_BYTES = 1_000_000;
const RESOLVED_PRIORITY_FACT_BODY_MAX_BYTES = 100_000;
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

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  isNumber(value) && Number.isInteger(value) && value >= 0;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

const isJsonValue = (value: unknown, depth = 0): boolean => {
  if (depth > 24) return false;
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry, depth + 1));
  }
  if (isRecord(value)) {
    return Object.values(value).every((entry) => isJsonValue(entry, depth + 1));
  }
  return false;
};

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && Object.values(value).every((entry) => isJsonValue(entry));

const isPriorityTargetKind = (
  value: unknown,
): value is ResolvedPriorityFactRecord["targetKind"] =>
  value === "diff" || value === "node" || value === "heap";

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
    .bind(target.rootDropId, target.branchId, target.snapshotId, target.resolverId)
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
  const delta = parseJsonColumn(row?.heap_delta_json, isResolvedHeapDeltaRecord);
  return delta;
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
    const node = await readResolvedNodePayloadFromD1(db, ref.nodeHash, resolverId);
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
    .bind(target.rootDropId, target.branchId, target.snapshotId, target.resolverId)
    .all<{ node_id: string; node_json: string }>();

  const nodes: Array<ResolvedDocumentNode | ResolvedRuntimeNode> = [];
  const seen = new Set<string>();
  for (const row of results) {
    if (!refIds.has(row.node_id)) continue;
    const node = target.resolverId === RESOLVED_RUNTIME_REFS_RESOLVER_ID
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

interface ResolvedPriorityScoring {
  priorityByNodeId?: Record<string, number>;
  priorityByDiffEventId?: Record<string, number>;
  heapPriority?: number;
}

interface ResolvedPriorityFactListOptions {
  resolverId?: string;
  targetKind?: ResolvedPriorityFactRecord["targetKind"];
  targetId?: string;
  factId?: string;
  limit?: number;
}

interface ResolvedPriorityFactDeleteParams extends ResolvedHeapParams {
  factId: string | string[];
}

const readResolvedPriorityFactsFromD1 = async (
  db: VoidSqlStore | undefined,
  rootDropId: string,
  branchId: string,
  resolverId: string,
): Promise<ResolvedPriorityFactRecord[]> => {
  if (!db) return [];

  const { results = [] } = await db
    .prepare(
      `SELECT fact_json
       FROM resolved_priority_facts
       WHERE root_drop_id = ?
         AND (branch_id = '' OR branch_id = ?)
         AND (resolver_id = '' OR resolver_id = ?)
       ORDER BY created_at DESC`,
    )
    .bind(rootDropId, branchId, resolverId)
    .all<{ fact_json: string }>();

  return results
    .map((row) => parseJsonColumn(row.fact_json, isResolvedPriorityFactRecord))
    .filter((fact): fact is ResolvedPriorityFactRecord => fact !== null);
};

const writeResolvedPriorityFactToD1 = async (
  db: VoidSqlStore,
  fact: ResolvedPriorityFactRecord,
): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO resolved_priority_facts (
         root_drop_id, branch_id, resolver_id, target_kind, target_id,
         fact_id, priority, created_at, source_seq, source_event_id, fact_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(root_drop_id, branch_id, resolver_id, target_kind, target_id, fact_id)
       DO UPDATE SET
         priority = excluded.priority,
         created_at = excluded.created_at,
         source_seq = excluded.source_seq,
         source_event_id = excluded.source_event_id,
         fact_json = excluded.fact_json`,
    )
    .bind(
      fact.rootDropId,
      fact.branchId ?? "",
      fact.resolverId ?? "",
      fact.targetKind,
      fact.targetId,
      fact.factId,
      fact.priority,
      fact.createdAt,
      fact.sourceSeq ?? null,
      fact.sourceEventId ?? null,
      JSON.stringify(fact),
    )
    .run();
};

const listBranchResolvedPriorityFactsFromD1 = async (
  db: VoidSqlStore,
  rootDropId: string,
  branchId: string,
  options: ResolvedPriorityFactListOptions = {},
): Promise<ResolvedPriorityFactRecord[]> => {
  const limit = Math.max(1, Math.min(250, Math.floor(options.limit ?? 100)));
  const conditions = ["root_drop_id = ?", "branch_id = ?"];
  const bindings: (string | number)[] = [rootDropId, branchId];
  if (options.resolverId) {
    conditions.push("resolver_id = ?");
    bindings.push(options.resolverId);
  }
  if (options.targetKind) {
    conditions.push("target_kind = ?");
    bindings.push(options.targetKind);
  }
  if (options.targetId) {
    conditions.push("target_id = ?");
    bindings.push(options.targetId);
  }
  if (options.factId) {
    conditions.push("fact_id = ?");
    bindings.push(options.factId);
  }
  bindings.push(limit);

  const { results = [] } = await db
    .prepare(
      `SELECT fact_json
       FROM resolved_priority_facts
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .bind(...bindings)
    .all<{ fact_json: string }>();

  return results
    .map((row) => parseJsonColumn(row.fact_json, isResolvedPriorityFactRecord))
    .filter((fact): fact is ResolvedPriorityFactRecord => fact !== null);
};

const readBranchResolvedPriorityFactFromD1 = async (
  db: VoidSqlStore,
  rootDropId: string,
  branchId: string,
  factId: string,
): Promise<ResolvedPriorityFactRecord | null> => {
  const row = await db
    .prepare(
      `SELECT fact_json
       FROM resolved_priority_facts
       WHERE root_drop_id = ? AND branch_id = ? AND fact_id = ?
       LIMIT 1`,
    )
    .bind(rootDropId, branchId, factId)
    .first<{ fact_json: string }>();
  return row ? parseJsonColumn(row.fact_json, isResolvedPriorityFactRecord) : null;
};

const deleteBranchResolvedPriorityFactFromD1 = async (
  db: VoidSqlStore,
  rootDropId: string,
  branchId: string,
  factId: string,
): Promise<void> => {
  await db
    .prepare(
      `DELETE FROM resolved_priority_facts
       WHERE root_drop_id = ? AND branch_id = ? AND fact_id = ?`,
    )
    .bind(rootDropId, branchId, factId)
    .run();
};

const priorityScoringFromFacts = (
  facts: readonly ResolvedPriorityFactRecord[],
): ResolvedPriorityScoring => {
  const priorityByNodeId: Record<string, number> = {};
  const priorityByDiffEventId: Record<string, number> = {};
  let heapPriority: number | undefined;

  for (const fact of facts) {
    if (fact.targetKind === "node") {
      if (!Object.prototype.hasOwnProperty.call(priorityByNodeId, fact.targetId)) {
        priorityByNodeId[fact.targetId] = fact.priority;
      }
    } else if (fact.targetKind === "diff") {
      if (!Object.prototype.hasOwnProperty.call(priorityByDiffEventId, fact.targetId)) {
        priorityByDiffEventId[fact.targetId] = fact.priority;
      }
    } else if (fact.targetKind === "heap" && heapPriority === undefined) {
      heapPriority = fact.priority;
    }
  }

  return {
    priorityByNodeId: Object.keys(priorityByNodeId).length
      ? priorityByNodeId
      : undefined,
    priorityByDiffEventId: Object.keys(priorityByDiffEventId).length
      ? priorityByDiffEventId
      : undefined,
    heapPriority,
  };
};

const readResolvedPriorityScoring = async (
  db: VoidSqlStore | undefined,
  rootDropId: string,
  branchId: string,
  resolverId: string,
): Promise<ResolvedPriorityScoring> => {
  const facts = await readResolvedPriorityFactsFromD1(
    db,
    rootDropId,
    branchId,
    resolverId,
  );
  return priorityScoringFromFacts(facts);
};

const readResolvedState = async (
  env: ResolvedHeapEnv,
  rootDropId: string,
  branchId: string,
  resolverId: string,
  snapshotId: number,
): Promise<ResolvedNulldownState | null> => {
  if (env.DB) {
    const deltaState = await readResolvedStateFromD1Delta(
      env.DB,
      rootDropId,
      branchId,
      resolverId,
      snapshotId,
    );
    if (deltaState) return deltaState;

    const row = await env.DB
      .prepare(
        `SELECT state_json
         FROM resolved_heaps
         WHERE root_drop_id = ? AND branch_id = ? AND snapshot_id = ? AND resolver_id = ?`,
      )
      .bind(rootDropId, branchId, snapshotId, resolverId)
      .first<{ state_json: string }>();
    const state = parseJsonColumn(row?.state_json, isResolvedNulldownState);
    if (state) return state;
  }

  return readResolvedNulldownState(
    env.R2_BUCKET,
    rootDropId,
    branchId,
    resolverId,
    snapshotId,
  );
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

  const nodes = [
    ...(state.documentNodes ?? []),
    ...(state.runtimeNodes ?? []),
  ];
  for (const node of nodes) {
    await db
      .prepare(
        `INSERT INTO resolved_nodes (
           root_drop_id, branch_id, snapshot_id, resolver_id, node_id,
           kind, source_start, source_end, text, importance, node_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  const nodes = [
    ...(state.documentNodes ?? []),
    ...(state.runtimeNodes ?? []),
  ];
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

const shouldCheckpointResolvedHeap = (snapshotId: number, parentResolved: boolean): boolean =>
  snapshotId === 0 ||
  !parentResolved ||
  snapshotId % RESOLVED_HEAP_CHECKPOINT_INTERVAL === 0;

const syncResolvedHeapDeltaToD1 = async (
  db: VoidSqlStore | undefined,
  state: ResolvedNulldownState,
): Promise<void> => {
  if (!db || !state.branchId || state.snapshotId === undefined) return;
  const parent = state.snapshotId > 0
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

/** Writes resolved heap and node metadata into D1 without touching R2 blobs. */
export const syncResolvedStateToD1 = async (
  db: VoidSqlStore | undefined,
  state: ResolvedNulldownState,
): Promise<void> => {
  if (!db || !state.branchId || state.snapshotId === undefined) return;

  await db
    .prepare(
      `INSERT INTO resolved_heaps (
         root_drop_id, branch_id, snapshot_id, resolver_id, resolver_version,
         source_content_hash, resolved_at, state_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(root_drop_id, branch_id, snapshot_id, resolver_id) DO UPDATE SET
         resolver_version = excluded.resolver_version,
         source_content_hash = excluded.source_content_hash,
         resolved_at = excluded.resolved_at,
         state_json = excluded.state_json`,
    )
    .bind(
      state.rootDropId,
      state.branchId,
      state.snapshotId,
      state.resolverId,
      state.resolverVersion,
      state.sourceContentHash,
      state.resolvedAt,
      JSON.stringify(state),
    )
    .run();
  await syncResolvedNodesToD1(db, state);
  await syncResolvedHeapDeltaToD1(db, state);
};

const writeResolvedState = async (
  env: ResolvedHeapEnv,
  state: ResolvedNulldownState,
): Promise<string> => {
  const key = await writeResolvedNulldownState(env.R2_BUCKET, state);
  await syncResolvedStateToD1(env.DB, state);
  return key;
};

const parsePositiveInteger = (
  value: string | null,
  fallback: number,
): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseOptionalSeq = (value: string | null): number | null => {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const parseBoolean = (value: string | null): boolean =>
  value === "1" || value === "true" || value === "yes";

const sourceSeqRangeForHead = (
  headEventSeq: number | null | undefined,
): { from: number; to: number } | undefined =>
  typeof headEventSeq === "number" && headEventSeq >= 0
    ? { from: 0, to: headEventSeq }
    : undefined;

const parseKinds = (
  value: string | null,
): ResolvedDocumentNodeKind[] | undefined => {
  if (!value) return undefined;
  const kinds = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry): entry is ResolvedDocumentNodeKind =>
      DOCUMENT_NODE_KINDS.has(entry as ResolvedDocumentNodeKind),
    );
  return kinds.length ? kinds : undefined;
};

const parseRuntimeKinds = (
  value: string | null,
): ResolvedRuntimeNodeKind[] | undefined => {
  if (!value) return undefined;
  const kinds = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry): entry is ResolvedRuntimeNodeKind =>
      RUNTIME_NODE_KINDS.has(entry as ResolvedRuntimeNodeKind),
    );
  return kinds.length ? kinds : undefined;
};

const parseUpdateBody = (rawBody: string): ResolvedUpdateRequest | null => {
  if (!rawBody.trim()) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  const resolverId = parsed.resolverId;
  if (
    resolverId !== undefined &&
    resolverId !== "all" &&
    resolverId !== RESOLVED_DOCUMENT_RESOLVER_ID &&
    resolverId !== RESOLVED_RUNTIME_REFS_RESOLVER_ID
  ) {
    return null;
  }
  if (
    parsed.snapshotId !== undefined &&
    parsed.snapshotId !== "latest" &&
    !(
      typeof parsed.snapshotId === "number" &&
      Number.isInteger(parsed.snapshotId) &&
      parsed.snapshotId >= 0
    )
  ) {
    return null;
  }
  if (
    parsed.uiPrimitives !== undefined &&
    (!Array.isArray(parsed.uiPrimitives) ||
      !parsed.uiPrimitives.every(isNullplugUiPrimitive))
  ) {
    return null;
  }
  if (
    parsed.uiResponseFacts !== undefined &&
    (!Array.isArray(parsed.uiResponseFacts) ||
      !parsed.uiResponseFacts.every(isNullplugUiResponseFact))
  ) {
    return null;
  }
  if (
    parsed.uiStatePatchFacts !== undefined &&
    (!Array.isArray(parsed.uiStatePatchFacts) ||
      !parsed.uiStatePatchFacts.every(isNullplugUiStatePatchFact))
  ) {
    return null;
  }
  if (
    parsed.uiStateSnapshots !== undefined &&
    (!Array.isArray(parsed.uiStateSnapshots) ||
      !parsed.uiStateSnapshots.every(isNullplugUiStateSnapshot))
  ) {
    return null;
  }

  return parsed as ResolvedUpdateRequest;
};

const parsePriorityFactBody = (
  rawBody: string,
): ResolvedPriorityFactRequest | null => {
  if (!rawBody.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  if (parsed.factId !== undefined && !isString(parsed.factId)) return null;
  if (parsed.resolverId !== undefined && !isString(parsed.resolverId)) return null;
  if (!isPriorityTargetKind(parsed.targetKind)) return null;
  if (parsed.targetId !== undefined && !isString(parsed.targetId)) return null;
  if (!isNumber(parsed.priority)) return null;
  if (parsed.sourceSeq !== undefined && !isNonNegativeInteger(parsed.sourceSeq)) {
    return null;
  }
  if (parsed.sourceEventId !== undefined && !isString(parsed.sourceEventId)) {
    return null;
  }
  if (parsed.reason !== undefined && !isString(parsed.reason)) return null;
  if (parsed.labels !== undefined && !isStringArray(parsed.labels)) return null;
  if (parsed.metadata !== undefined && !isJsonRecord(parsed.metadata)) return null;

  return parsed as ResolvedPriorityFactRequest;
};

const defaultPriorityTargetId = (
  rootDropId: string,
  branchId: string,
  resolverId: string | undefined,
  targetKind: ResolvedPriorityFactRecord["targetKind"],
): string =>
  targetKind === "heap" ? `${rootDropId}/${branchId}/${resolverId ?? ""}` : "";

const resolveBranchTarget = async (
  env: ResolvedHeapEnv,
  params: ResolvedHeapParams,
) => {
  if (!env.R2_BUCKET) {
    return {
      error: new Response("R2 bucket binding is required.", { status: 500 }),
    };
  }

  const rootDropId = await resolveRemoteDropId(
    env.R2_BUCKET,
    resolveParam(params.rootId),
    undefined,
    env.DB,
  );
  const branchId = sanitizeDiffAuthToken(resolveParam(params.branchId));
  if (!rootDropId || !branchId) {
    return {
      error: jsonErrorResponse(
        400,
        "validation_failed",
        "Root drop ID and branch ID are required.",
      ),
    };
  }

  const branch = await readBranch(env.R2_BUCKET, rootDropId, branchId, env.DB);
  if (!branch) {
    return {
      error: jsonErrorResponse(404, "branch_not_found", "Branch not found."),
    };
  }

  return { rootDropId, branchId, branch };
};

const authorizeResolvedPriorityFactWrite = async (
  request: Request,
  env: ResolvedHeapEnv,
  branch: { ownerAccountId?: string | null; writerAccountId?: string | null },
  action: "create" | "list" | "delete",
): Promise<Response | null> => {
  const accountId = await resolveAuthenticatedAccountId(request, env);
  if (!accountId) {
    return jsonErrorResponse(
      401,
      "account_required",
      "Authenticated account session is required.",
    );
  }

  const canWrite =
    accountId === branch.ownerAccountId || accountId === branch.writerAccountId;
  if (!canWrite) {
    return jsonErrorResponse(
      403,
      "forbidden",
      `You are not allowed to ${action} priority facts for this branch.`,
    );
  }

  return null;
};

const queryResolvedHeapUnsafe = async (
  env: ResolvedHeapEnv,
  params: ResolvedHeapParams,
  request: Request,
): Promise<Response> => {
  const target = await resolveBranchTarget(env, params);
  if (target.error) return target.error;
  const { rootDropId, branchId, branch } = target;

  const url = new URL(request.url);
  const resolverId =
    url.searchParams.get("resolverId") || RESOLVED_DOCUMENT_RESOLVER_ID;
  const snapshotParam = url.searchParams.get("snapshotId") || "latest";
  const snapshotId =
    snapshotParam === "latest"
      ? branch.headSnapshotId
      : Number.parseInt(snapshotParam, 10);
  if (!Number.isFinite(snapshotId) || snapshotId < 0) {
    return jsonErrorResponse(400, "validation_failed", "Invalid snapshotId.");
  }

  const content = await readBranchContent(
    env.R2_BUCKET,
    rootDropId,
    branchId,
    snapshotId,
    env.DB,
  );
  if (content === null) {
    return jsonErrorResponse(
      404,
      "snapshot_content_not_found",
      "Snapshot content not found.",
    );
  }

  const sourceContentHash = await hashBranchSnapshotSource({
    rootDropId,
    branchId,
    snapshotId,
    content,
  });
  let state = await readResolvedState(
    env,
    rootDropId,
    branchId,
    resolverId,
    snapshotId,
  );
  let heapGenerated = false;
  let stale = Boolean(state && state.sourceContentHash !== sourceContentHash);

  if ((!state || stale) && resolverId === RESOLVED_DOCUMENT_RESOLVER_ID) {
    state = await heapifyResolvedDocument({
      rootDropId,
      branchId,
      snapshotId,
      sourceSeqRange: sourceSeqRangeForHead(branch.headEventSeq),
      content,
    });
    await writeResolvedState(env, state);
    heapGenerated = true;
    stale = false;
  }

  if ((!state || stale) && resolverId === RESOLVED_RUNTIME_REFS_RESOLVER_ID) {
    const runtimeFacts = await listNullplugRuntimeFacts(
      env.R2_BUCKET,
      rootDropId,
      branchId,
      env.DB,
    );
    state = await heapifyResolvedRuntimeRefs({
      rootDropId,
      branchId,
      snapshotId,
      sourceSeqRange: sourceSeqRangeForHead(branch.headEventSeq),
      content,
      uiResponseFacts: runtimeFacts.uiResponseFacts,
      uiStatePatchFacts: runtimeFacts.uiStatePatchFacts,
      uiStateSnapshots: runtimeFacts.uiStateSnapshots,
    });
    await writeResolvedState(env, state);
    heapGenerated = true;
    stale = false;
  }

  if (!state) {
    return jsonErrorResponse(
      404,
      "resolved_heap_not_found",
      "Resolved heap not found.",
    );
  }

  const priorityScoring = await readResolvedPriorityScoring(
    env.DB,
    rootDropId,
    branchId,
    state.resolverId,
  );

  if (state.resolverId === RESOLVED_RUNTIME_REFS_RESOLVER_ID) {
    const nodes = queryResolvedRuntimeNodes(state, {
      q:
        url.searchParams.get("q") || url.searchParams.get("query") || undefined,
      kinds: parseRuntimeKinds(url.searchParams.get("kind")),
      limit: parsePositiveInteger(
        url.searchParams.get("k") || url.searchParams.get("top"),
        10,
      ),
      pluginId: url.searchParams.get("pluginId") || undefined,
      callId: url.searchParams.get("callId") || undefined,
      primitiveId: url.searchParams.get("primitiveId") || undefined,
      priorityByNodeId: priorityScoring.priorityByNodeId,
      heapPriority: priorityScoring.heapPriority,
    });

    return jsonResponse({
      rootDropId,
      branchId,
      snapshotId,
      resolverId: state.resolverId,
      resolverVersion: state.resolverVersion,
      sourceContentHash: state.sourceContentHash,
      stale,
      heapGenerated,
      nodeCount: state.runtimeNodes?.length ?? 0,
      nodes,
    });
  }

  const fromSeq = parseOptionalSeq(url.searchParams.get("fromSeq"));
  const toSeq = parseOptionalSeq(url.searchParams.get("toSeq"));
  const events =
    fromSeq !== null || toSeq !== null
      ? await readBranchEventsBySeqRange(
          env.R2_BUCKET,
          rootDropId,
          branchId,
          fromSeq ?? toSeq ?? 0,
          toSeq ?? fromSeq ?? 0,
          env.DB,
        )
      : [];
  const includeEventMetadata =
    url.searchParams.get("includeEventMetadata") !== "false";
  const eventRefs = changedRangesFromDropDiffEvents(events).map((event) =>
    includeEventMetadata ? event : { ...event, metadata: undefined },
  );
  const nodes = queryResolvedDocumentNodes(state, {
    q: url.searchParams.get("q") || url.searchParams.get("query") || undefined,
    kinds: parseKinds(url.searchParams.get("kind")),
    limit: parsePositiveInteger(
      url.searchParams.get("k") || url.searchParams.get("top"),
      10,
    ),
    events: eventRefs,
    changedOnly: parseBoolean(url.searchParams.get("changedOnly")),
    includeAncestors: parseBoolean(url.searchParams.get("includeAncestors")),
    priorityByNodeId: priorityScoring.priorityByNodeId,
    priorityByDiffEventId: priorityScoring.priorityByDiffEventId,
    heapPriority: priorityScoring.heapPriority,
  });

  return jsonResponse({
    rootDropId,
    branchId,
    snapshotId,
    resolverId: state.resolverId,
    resolverVersion: state.resolverVersion,
    sourceContentHash: state.sourceContentHash,
    stale,
    heapGenerated,
    nodeCount: state.documentNodes?.length ?? 0,
    nodes,
  });
};

/** Queries a branch resolved heap, regenerating supported stale heaps on demand. */
export const queryResolvedHeap = async (
  env: ResolvedHeapEnv,
  params: ResolvedHeapParams,
  request: Request,
): Promise<Response> => {
  try {
    return await queryResolvedHeapUnsafe(env, params, request);
  } catch (error) {
    if (isApiHttpError(error)) {
      return apiHttpErrorResponse(error);
    }

    const message = error instanceof Error ? error.message : String(error);
    return jsonErrorResponse(
      500,
      "resolved_query_failed",
      `Failed to query resolved heap: ${message}`,
    );
  }
};

const createResolvedPriorityFactUnsafe = async (
  env: ResolvedHeapEnv,
  params: ResolvedHeapParams,
  request: Request,
): Promise<Response> => {
  if (!env.DB) {
    return jsonErrorResponse(
      500,
      "sql_store_required",
      "SQL metadata store is required to create resolved priority facts.",
    );
  }

  const target = await resolveBranchTarget(env, params);
  if (target.error) return target.error;
  const { rootDropId, branchId, branch } = target;

  const authError = await authorizeResolvedPriorityFactWrite(
    request,
    env,
    branch,
    "create",
  );
  if (authError) return authError;

  const rawBody = await readRequestTextWithLimit(
    request,
    RESOLVED_PRIORITY_FACT_BODY_MAX_BYTES,
  );
  const parsed = parsePriorityFactBody(rawBody);
  if (!parsed || parsed.priority === undefined || !parsed.targetKind) {
    return jsonErrorResponse(
      400,
      "validation_failed",
      "Priority fact payload must include targetKind and priority.",
    );
  }

  const resolverId = parsed.resolverId ??
    (parsed.targetKind === "node" ? RESOLVED_DOCUMENT_RESOLVER_ID : undefined);
  const targetId = parsed.targetId ??
    defaultPriorityTargetId(rootDropId, branchId, resolverId, parsed.targetKind);
  if (!targetId) {
    return jsonErrorResponse(
      400,
      "validation_failed",
      "targetId is required for node and diff priority facts.",
    );
  }

  const fact: ResolvedPriorityFactRecord = {
    version: RESOLVED_PRIORITY_FACT_RECORD_VERSION,
    factId: parsed.factId ?? `priority:${crypto.randomUUID()}`,
    rootDropId,
    branchId,
    resolverId,
    targetKind: parsed.targetKind,
    targetId,
    priority: parsed.priority,
    createdAt: Date.now(),
    sourceSeq: parsed.sourceSeq,
    sourceEventId: parsed.sourceEventId,
    reason: parsed.reason,
    labels: parsed.labels,
    metadata: parsed.metadata as Record<string, JsonValue> | undefined,
  };

  if (!isResolvedPriorityFactRecord(fact)) {
    return jsonErrorResponse(
      400,
      "validation_failed",
      "Priority fact payload is invalid.",
    );
  }

  await writeResolvedPriorityFactToD1(env.DB, fact);
  return jsonResponse({ rootDropId, branchId, fact }, 201);
};

const listResolvedPriorityFactsUnsafe = async (
  env: ResolvedHeapEnv,
  params: ResolvedHeapParams,
  request: Request,
): Promise<Response> => {
  if (!env.DB) {
    return jsonErrorResponse(
      500,
      "sql_store_required",
      "SQL metadata store is required to list resolved priority facts.",
    );
  }

  const target = await resolveBranchTarget(env, params);
  if (target.error) return target.error;
  const { rootDropId, branchId, branch } = target;
  const authError = await authorizeResolvedPriorityFactWrite(
    request,
    env,
    branch,
    "list",
  );
  if (authError) return authError;

  const url = new URL(request.url);
  const targetKindParam = url.searchParams.get("targetKind") ?? url.searchParams.get("target-kind");
  if (targetKindParam !== null && !isPriorityTargetKind(targetKindParam)) {
    return jsonErrorResponse(400, "validation_failed", "Invalid targetKind.");
  }

  const facts = await listBranchResolvedPriorityFactsFromD1(
    env.DB,
    rootDropId,
    branchId,
    {
      resolverId: url.searchParams.get("resolverId") ?? url.searchParams.get("resolver") ?? undefined,
      targetKind: targetKindParam ?? undefined,
      targetId: url.searchParams.get("targetId") ?? url.searchParams.get("target") ?? undefined,
      factId: url.searchParams.get("factId") ?? url.searchParams.get("fact") ?? undefined,
      limit: parsePositiveInteger(url.searchParams.get("limit"), 100),
    },
  );

  return jsonResponse({ rootDropId, branchId, facts });
};

const deleteResolvedPriorityFactUnsafe = async (
  env: ResolvedHeapEnv,
  params: ResolvedPriorityFactDeleteParams,
  request: Request,
): Promise<Response> => {
  if (!env.DB) {
    return jsonErrorResponse(
      500,
      "sql_store_required",
      "SQL metadata store is required to delete resolved priority facts.",
    );
  }

  const target = await resolveBranchTarget(env, params);
  if (target.error) return target.error;
  const { rootDropId, branchId, branch } = target;
  const authError = await authorizeResolvedPriorityFactWrite(
    request,
    env,
    branch,
    "delete",
  );
  if (authError) return authError;

  const factId = resolveParam(params.factId);
  if (!factId) {
    return jsonErrorResponse(400, "validation_failed", "factId is required.");
  }

  const existing = await readBranchResolvedPriorityFactFromD1(
    env.DB,
    rootDropId,
    branchId,
    factId,
  );
  if (!existing) {
    return jsonErrorResponse(404, "priority_fact_not_found", "Priority fact not found.");
  }

  await deleteBranchResolvedPriorityFactFromD1(env.DB, rootDropId, branchId, factId);
  return jsonResponse({ rootDropId, branchId, factId, deleted: true });
};

/** Creates a branch-scoped resolved priority fact used by future heap queries. */
export const createResolvedPriorityFact = async (
  env: ResolvedHeapEnv,
  params: ResolvedHeapParams,
  request: Request,
): Promise<Response> => {
  try {
    return await createResolvedPriorityFactUnsafe(env, params, request);
  } catch (error) {
    if (isApiHttpError(error)) {
      return apiHttpErrorResponse(error);
    }

    const message = error instanceof Error ? error.message : String(error);
    return jsonErrorResponse(
      500,
      "resolved_priority_fact_failed",
      `Failed to create resolved priority fact: ${message}`,
    );
  }
};

/** Lists branch-scoped resolved priority facts for branch writers. */
export const listResolvedPriorityFacts = async (
  env: ResolvedHeapEnv,
  params: ResolvedHeapParams,
  request: Request,
): Promise<Response> => {
  try {
    return await listResolvedPriorityFactsUnsafe(env, params, request);
  } catch (error) {
    if (isApiHttpError(error)) {
      return apiHttpErrorResponse(error);
    }

    const message = error instanceof Error ? error.message : String(error);
    return jsonErrorResponse(
      500,
      "resolved_priority_fact_list_failed",
      `Failed to list resolved priority facts: ${message}`,
    );
  }
};

/** Deletes one branch-scoped resolved priority fact for branch writers. */
export const deleteResolvedPriorityFact = async (
  env: ResolvedHeapEnv,
  params: ResolvedPriorityFactDeleteParams,
  request: Request,
): Promise<Response> => {
  try {
    return await deleteResolvedPriorityFactUnsafe(env, params, request);
  } catch (error) {
    if (isApiHttpError(error)) {
      return apiHttpErrorResponse(error);
    }

    const message = error instanceof Error ? error.message : String(error);
    return jsonErrorResponse(
      500,
      "resolved_priority_fact_delete_failed",
      `Failed to delete resolved priority fact: ${message}`,
    );
  }
};

/** Rebuilds and stores one or more resolved heaps for a branch snapshot. */
export const updateResolvedHeap = async (
  env: ResolvedHeapEnv,
  params: ResolvedHeapParams,
  request: Request,
): Promise<Response> => {
  try {
    const target = await resolveBranchTarget(env, params);
    if (target.error) return target.error;
    const { rootDropId, branchId, branch } = target;

    const rawBody = await readRequestTextWithLimit(
      request,
      RESOLVED_UPDATE_BODY_MAX_BYTES,
    );
    const parsed = parseUpdateBody(rawBody);
    if (!parsed) {
      return jsonErrorResponse(
        400,
        "validation_failed",
        "Invalid resolved heap update payload.",
      );
    }

    const snapshotId =
      parsed.snapshotId === undefined || parsed.snapshotId === "latest"
        ? branch.headSnapshotId
        : parsed.snapshotId;
    const content = await readBranchContent(
      env.R2_BUCKET,
      rootDropId,
      branchId,
      snapshotId,
      env.DB,
    );
    if (content === null) {
      return jsonErrorResponse(
        404,
        "snapshot_content_not_found",
        "Snapshot content not found.",
      );
    }

    const sourceContentHash = await hashBranchSnapshotSource({
      rootDropId,
      branchId,
      snapshotId,
      content,
    });
    const resolverId = parsed.resolverId ?? "all";
    const updated: Array<{
      resolverId: string;
      key: string;
      nodeCount: number;
      sourceContentHash: string;
    }> = [];

    if (resolverId === "all" || resolverId === RESOLVED_DOCUMENT_RESOLVER_ID) {
      const state = await heapifyResolvedDocument({
        rootDropId,
        branchId,
        snapshotId,
        sourceSeqRange: sourceSeqRangeForHead(branch.headEventSeq),
        content,
      });
      const key = await writeResolvedState(env, state);
      updated.push({
        resolverId: state.resolverId,
        key,
        nodeCount: state.documentNodes?.length ?? 0,
        sourceContentHash: state.sourceContentHash,
      });
    }

    if (
      resolverId === "all" ||
      resolverId === RESOLVED_RUNTIME_REFS_RESOLVER_ID
    ) {
      const runtimeFacts = await listNullplugRuntimeFacts(
        env.R2_BUCKET,
        rootDropId,
        branchId,
        env.DB,
      );
      const state = await heapifyResolvedRuntimeRefs({
        rootDropId,
        branchId,
        snapshotId,
        sourceSeqRange: sourceSeqRangeForHead(branch.headEventSeq),
        content,
        uiPrimitives: parsed.uiPrimitives,
        uiResponseFacts: [
          ...runtimeFacts.uiResponseFacts,
          ...(parsed.uiResponseFacts ?? []),
        ],
        uiStatePatchFacts: [
          ...runtimeFacts.uiStatePatchFacts,
          ...(parsed.uiStatePatchFacts ?? []),
        ],
        uiStateSnapshots: [
          ...runtimeFacts.uiStateSnapshots,
          ...(parsed.uiStateSnapshots ?? []),
        ],
      });
      const key = await writeResolvedState(env, state);
      updated.push({
        resolverId: state.resolverId,
        key,
        nodeCount: state.runtimeNodes?.length ?? 0,
        sourceContentHash: state.sourceContentHash,
      });
    }

    return jsonResponse({
      rootDropId,
      branchId,
      snapshotId,
      sourceContentHash,
      updated,
    });
  } catch (error) {
    if (isApiHttpError(error)) {
      return apiHttpErrorResponse(error);
    }
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Failed to update resolved heap: ${message}`, {
      status: 500,
    });
  }
};

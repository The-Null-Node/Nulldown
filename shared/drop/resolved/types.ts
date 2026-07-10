import type {
  DropDiffEventMetadata,
  JsonValue,
} from "../diff";
import {
  NULLDOWN_SOURCE_HASH_PREFIX,
  RESOLVED_HEAP_DELTA_RECORD_VERSION,
  RESOLVED_NODE_REF_RECORD_VERSION,
  RESOLVED_PRIORITY_FACT_RECORD_VERSION,
} from "./constants";
import type {
  NullplugUiPrimitive,
  NullplugUiResponseFact,
  NullplugUiSource,
  NullplugUiStatePatchFact,
  NullplugUiStateSnapshot,
} from "../../nullplug/ui";

export type NulldownSourceHash = `${typeof NULLDOWN_SOURCE_HASH_PREFIX}${string}`;

export type NulldownContextQueryKind =
  | "checklist.next"
  | "plan.status"
  | "dependency.edges"
  | "policy.pending";

export interface NulldownContextQueryHint {
  dropId: string;
  kind: NulldownContextQueryKind;
}

export interface NulldownContextToken {
  version: 1;
  rootDropId: string;
  branchId?: string;
  snapshotId?: number;
  checklistDropId?: string;
  resolvedHeapIds: string[];
  sourceHashes: Record<string, NulldownSourceHash>;
  queryHints: NulldownContextQueryHint[];
}

export interface ResolvedSourceRange {
  start: number;
  end: number;
}

export interface ResolvedSourceSeqRange {
  from: number;
  to: number;
}

export interface ResolvedChecklistItem {
  id: string;
  text: string;
  checked: boolean;
  phase?: string;
  importance?: number;
  sourceRange?: ResolvedSourceRange;
  sourceHash: NulldownSourceHash;
}

export interface ResolvedPluginRef {
  id: string;
  pluginId: string;
  dropId?: string;
  sourceRange?: ResolvedSourceRange;
  sourceHash: NulldownSourceHash;
}

export interface ResolvedPolicyFact {
  id: string;
  kind: string;
  text: string;
  sourceRange?: ResolvedSourceRange;
  sourceHash: NulldownSourceHash;
  importance?: number;
}

export interface ResolvedUiResponseRef {
  id: string;
  primitiveId: string;
  source: NullplugUiSource;
  createdAt: number;
  proposedDiffEventCount?: number;
  responseHash: NulldownSourceHash;
}

export type ResolvedRuntimeNodeKind =
  | "nullplug.ref"
  | "ui.primitive"
  | "ui.state"
  | "ui.response";

export interface ResolvedRuntimeNode {
  id: string;
  kind: ResolvedRuntimeNodeKind;
  text: string;
  sourceHash: NulldownSourceHash;
  sourceRange?: ResolvedSourceRange;
  source?: NullplugUiSource;
  pluginId?: string;
  dropId?: string;
  callId?: string;
  primitiveId?: string;
  createdAt?: number;
  importance?: number;
}

export type ResolvedDocumentNodeKind =
  | "document.title"
  | "section"
  | "heading"
  | "paragraph"
  | "list.item"
  | "checklist.item"
  | "code.block"
  | "nullplug.ref"
  | "link.ref"
  | "diff.region";

export interface ResolvedDocumentNode {
  id: string;
  kind: ResolvedDocumentNodeKind;
  text: string;
  sourceRange: ResolvedSourceRange;
  sourceHash: NulldownSourceHash;
  headingPath?: string[];
  sectionId?: string;
  parentId?: string;
  depth?: number;
  pluginId?: string;
  dropId?: string;
  href?: string;
  language?: string;
  checked?: boolean;
  importance?: number;
}

export interface ResolvedDiffEventRef {
  seq: number;
  eventId: string;
  sourceClientId?: string;
  createdAt?: number;
  metadata?: DropDiffEventMetadata;
  changedRanges: ResolvedSourceRange[];
}

export interface ResolvedDocumentQuery {
  q?: string;
  kinds?: ResolvedDocumentNodeKind[];
  limit?: number;
  changedRanges?: ResolvedSourceRange[];
  events?: ResolvedDiffEventRef[];
  changedOnly?: boolean;
  includeAncestors?: boolean;
  /** Latest agent priority score by semantic node id. */
  priorityByNodeId?: Record<string, number>;
  /** Latest agent priority score by branch diff event id. */
  priorityByDiffEventId?: Record<string, number>;
  /** Latest agent priority score for the whole semantic heap. */
  heapPriority?: number;
}

export interface ResolvedDocumentNodeQueryResult {
  node: ResolvedDocumentNode;
  score: number;
  reasons: string[];
  eventRefs?: ResolvedDiffEventRef[];
}

export interface ResolvedRuntimeQuery {
  q?: string;
  kinds?: ResolvedRuntimeNodeKind[];
  limit?: number;
  pluginId?: string;
  callId?: string;
  primitiveId?: string;
  /** Latest agent priority score by runtime node id. */
  priorityByNodeId?: Record<string, number>;
  /** Latest agent priority score for the whole runtime heap. */
  heapPriority?: number;
}

export interface ResolvedRuntimeNodeQueryResult {
  node: ResolvedRuntimeNode;
  score: number;
  reasons: string[];
}

export interface ResolvedNulldownState {
  version: 1;
  id: string;
  rootDropId: string;
  branchId?: string;
  snapshotId?: number;
  sourceRevision?: string;
  sourceSeqRange?: ResolvedSourceSeqRange;
  sourceContentHash: NulldownSourceHash;
  resolverId: string;
  resolverVersion: string;
  resolvedAt: number;
  title?: string;
  summary?: string;
  checklistItems?: ResolvedChecklistItem[];
  pluginRefs?: ResolvedPluginRef[];
  policyFacts?: ResolvedPolicyFact[];
  responseRefs?: ResolvedUiResponseRef[];
  documentNodes?: ResolvedDocumentNode[];
  runtimeNodes?: ResolvedRuntimeNode[];
  importance?: Record<string, number>;
}

/** Stable reference to one materialized semantic/resolved heap snapshot. */
export interface ResolvedHeapRef {
  /** Root drop id that owns the branch timeline. */
  rootDropId: string;
  /** Branch id that owns the resolved heap. */
  branchId: string;
  /** Branch snapshot id this heap describes. */
  snapshotId: number;
  /** Resolver that produced the heap. */
  resolverId: string;
}

/** Compact change applied to semantic node refs between resolved heap snapshots. */
export type ResolvedNodeDeltaOp =
  | {
      /** Inserts or replaces one semantic node ref. */
      op: "upsert";
      /** New semantic node ref for the target snapshot. */
      ref: ResolvedNodeRefRecord;
    }
  | {
      /** Removes a semantic node ref inherited from the parent heap. */
      op: "delete";
      /** Stable node id being removed. */
      nodeId: string;
      /** Previous node payload hash, when known, for diagnostics. */
      previousNodeHash?: NulldownSourceHash;
    };

/** Compact persisted heap descriptor that points at parent heap and changed semantic records. */
export interface ResolvedHeapDeltaRecord extends ResolvedHeapRef {
  /** Record schema version. */
  version: typeof RESOLVED_HEAP_DELTA_RECORD_VERSION;
  /** Resolver implementation version that produced the record. */
  resolverVersion: string;
  /** Parent heap identity when this record is a delta over a previous snapshot. */
  parent?: ResolvedHeapRef;
  /** Source content hash for the materialized snapshot. */
  sourceContentHash: NulldownSourceHash;
  /** Source branch event sequence range covered by this record. */
  sourceSeqRange?: ResolvedSourceSeqRange;
  /** Timestamp in milliseconds when the heap record was resolved. */
  resolvedAt: number;
  /** True when the record is self-contained enough to start recursive resolution. */
  checkpointed: boolean;
  /** Full semantic node refs when this record is a checkpoint. */
  nodeRefs?: ResolvedNodeRefRecord[];
  /** Compact node ref changes when this record is a delta over its parent. */
  nodeOps?: ResolvedNodeDeltaOp[];
  /** Diff events that explain this heap delta. */
  diffRefs?: ResolvedDiffEventRef[];
  /** Priority fact ids consulted while scoring this heap. */
  priorityFactIds?: string[];
  /** Optional title copied from the materialized heap for fast listing. */
  title?: string;
  /** Optional summary copied from the materialized heap for fast listing. */
  summary?: string;
}

/** Compact persisted semantic node reference used by heap delta records. */
export interface ResolvedNodeRefRecord {
  /** Record schema version. */
  version: typeof RESOLVED_NODE_REF_RECORD_VERSION;
  /** Stable node id within the resolver output. */
  nodeId: string;
  /** Node kind as emitted by the resolver. */
  kind: ResolvedDocumentNodeKind | ResolvedRuntimeNodeKind;
  /** Hash of the canonical node payload for de-duplicated storage. */
  nodeHash: NulldownSourceHash;
  /** Hash of the source content that produced this node. */
  sourceHash: NulldownSourceHash;
  /** Source byte range when the node comes from textual content. */
  sourceRange?: ResolvedSourceRange;
  /** Optional parent node id for recursive semantic traversal. */
  parentId?: string;
  /** Optional human-readable preview text for indexing and diagnostics. */
  text?: string;
  /** Importance score copied from the materialized node when available. */
  importance?: number;
}

/** Resolution-plan item kind for deferred materialization consumers. */
export type NulldownResolutionPlanItemKind =
  | "text"
  | "block"
  | "snapshot"
  | "asset"
  | "semantic-node"
  | "runtime-ref"
  | "diff-event";

/** Dedupe strategy used while building a resolution plan. */
export type NulldownResolutionPlanDedupeKey = "hash" | "ref" | "none";

/** Input item used to build a deferred materialization plan. */
export interface CreateNulldownResolutionPlanItemInput {
  /** Stable reference understood by the resolver or materializer. */
  ref: string;
  /** Content-addressed hash for the payload behind the ref. */
  hash: NulldownSourceHash;
  /** Consumer-facing item category. */
  kind: NulldownResolutionPlanItemKind;
  /** Stable order in the resolved output. */
  order: number;
  /** Payload size in bytes or UTF-8 text length, depending on kind. */
  size: number;
  /** Hash of the source content that produced this item, when distinct. */
  sourceHash?: NulldownSourceHash;
  /** Optional JSON metadata for future materializers. */
  metadata?: Record<string, JsonValue>;
  /** Optional inline payload for the single-small-item fast path. */
  inlineContent?: string;
}

/** Stable item returned in a deferred materialization plan. */
export interface NulldownResolutionPlanItem {
  /** Stable reference understood by the resolver or materializer. */
  ref: string;
  /** Content-addressed hash for the payload behind the ref. */
  hash: NulldownSourceHash;
  /** Consumer-facing item category. */
  kind: NulldownResolutionPlanItemKind;
  /** Stable order in the resolved output. */
  order: number;
  /** Payload size in bytes or UTF-8 text length, depending on kind. */
  size: number;
  /** Hash of the source content that produced this item, when distinct. */
  sourceHash?: NulldownSourceHash;
  /** Optional JSON metadata for future materializers. */
  metadata?: Record<string, JsonValue>;
}

/** Options for turning refs into a render/query/export resolution plan. */
export interface CreateNulldownResolutionPlanOptions {
  /** Root drop id that owns the source timeline. */
  rootDropId: string;
  /** Branch id that owns the source timeline, when branch-scoped. */
  branchId?: string;
  /** Snapshot id that produced this plan, when branch-scoped. */
  snapshotId?: number;
  /** Source content hash for the resolved snapshot or source object. */
  sourceContentHash: NulldownSourceHash;
  /** Resolver that produced this plan. */
  resolverId: string;
  /** Resolver implementation version that produced this plan. */
  resolverVersion?: string;
  /** Candidate refs before ordering and dedupe. */
  items: readonly CreateNulldownResolutionPlanItemInput[];
  /** Maximum size eligible for inline mode. Defaults to 4096. */
  inlineLimit?: number;
  /** Dedupe strategy. Defaults to hash to match content-addressed storage. */
  dedupeBy?: NulldownResolutionPlanDedupeKey;
}

/** Deferred materialization plan produced from stored refs. */
export interface NulldownSequenceResolutionPlan {
  /** Plan wire version. */
  version: 1;
  /** Materialization mode for larger or multi-item outputs. */
  mode: "sequence";
  /** Root drop id that owns the source timeline. */
  rootDropId: string;
  /** Branch id that owns the source timeline, when branch-scoped. */
  branchId?: string;
  /** Snapshot id that produced this plan, when branch-scoped. */
  snapshotId?: number;
  /** Source content hash for the resolved snapshot or source object. */
  sourceContentHash: NulldownSourceHash;
  /** Resolver that produced this plan. */
  resolverId: string;
  /** Resolver implementation version that produced this plan. */
  resolverVersion?: string;
  /** Number of refs in the sequence. */
  count: number;
  /** Ordered refs to materialize at the endpoint or client boundary. */
  sequence: NulldownResolutionPlanItem[];
}

/** Inline materialization plan for a single small resolved item. */
export interface NulldownInlineResolutionPlan
  extends Omit<NulldownSequenceResolutionPlan, "mode"> {
  /** Materialization mode for exactly one small item. */
  mode: "inline";
  /** Inline payload supplied by the resolver for the single-small-item fast path. */
  content: string;
}

/** Resolution output: inline only for one small item, otherwise an ordered sequence. */
export type NulldownResolutionPlan =
  | NulldownInlineResolutionPlan
  | NulldownSequenceResolutionPlan;

/** Persisted priority overlay that agents can attach to diffs, nodes, or heaps. */
export interface ResolvedPriorityFactRecord {
  /** Record schema version. */
  version: typeof RESOLVED_PRIORITY_FACT_RECORD_VERSION;
  /** Stable priority fact id. */
  factId: string;
  /** Root drop id the priority applies under. */
  rootDropId: string;
  /** Branch id the priority applies under. */
  branchId?: string;
  /** Resolver id when the target is resolver-specific. */
  resolverId?: string;
  /** Type of target being prioritized. */
  targetKind: "diff" | "node" | "heap";
  /** Stable target id, such as event id, node id, or heap key. */
  targetId: string;
  /** Agent-assigned priority score. Higher values should rank earlier. */
  priority: number;
  /** Timestamp in milliseconds when the fact was created. */
  createdAt: number;
  /** Optional branch event sequence that produced this priority fact. */
  sourceSeq?: number;
  /** Optional branch event id that produced this priority fact. */
  sourceEventId?: string;
  /** Optional explanation for later retrieval. */
  reason?: string;
  /** Optional retrieval labels attached by the writer. */
  labels?: string[];
  /** Optional extra JSON metadata for future agents. */
  metadata?: Record<string, JsonValue>;
}

/** Input for deriving a v2 semantic heap delta record from an existing resolved state. */
export interface CreateResolvedHeapDeltaRecordOptions {
  /** Materialized v1 state to describe with v2 refs. */
  state: ResolvedNulldownState;
  /** Optional parent heap ref for recursive delta resolution. */
  parent?: ResolvedHeapRef;
  /** Optional parent node refs used to emit compact delta operations. */
  parentNodeRefs?: readonly ResolvedNodeRefRecord[];
  /** Optional diff refs that explain this heap delta. */
  diffRefs?: ResolvedDiffEventRef[];
  /** Optional priority fact ids consulted while scoring the heap. */
  priorityFactIds?: string[];
  /** Whether the record is self-contained enough to start resolution. Defaults to true. */
  checkpointed?: boolean;
}

export interface BranchSnapshotSource {
  rootDropId: string;
  branchId: string;
  snapshotId: number;
  content: string;
}

export interface ResolvedChecklistSource {
  id?: string;
  rootDropId: string;
  branchId?: string;
  snapshotId?: number;
  sourceRevision?: string;
  sourceSeqRange?: ResolvedSourceSeqRange;
  content: string;
  resolverId?: string;
  resolverVersion?: string;
  resolvedAt?: number;
}

export interface ResolvedRuntimeRefsSource extends ResolvedChecklistSource {
  uiPrimitives?: NullplugUiPrimitive[];
  uiResponseFacts?: NullplugUiResponseFact[];
  uiStatePatchFacts?: NullplugUiStatePatchFact[];
  uiStateSnapshots?: NullplugUiStateSnapshot[];
}

export type ResolvedDocumentSource = ResolvedChecklistSource;

export interface ResolvedHeapJsonObject {
  json(): Promise<unknown>;
}

export interface ResolvedHeapJsonStore {
  get(key: string): Promise<ResolvedHeapJsonObject | null>;
  put(
    key: string,
    value: string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}

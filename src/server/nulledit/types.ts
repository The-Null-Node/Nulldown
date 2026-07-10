import type {
  DropBranchRecord,
  DropSnapshotRecord,
} from "../../../shared/drop/branch";
import type {
  DropDiffEvent,
  DropDiffEventKind,
  DropDiffRef,
  JsonValue,
} from "../../../shared/drop/diff";
import type { ResolvedPriorityFactRecord } from "../../../shared/drop/resolved/types";
import type { NullMemFactRecord, NullMemSourceRef } from "../../../shared/nullmem/types";
import type {
  NullplugUiResponseFact,
  NullplugUiStatePatchFact,
  NullplugUiStateSnapshot,
} from "../../../shared/nullplug/ui";
import type { VoidDataStore } from "../ports";

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

/** Durable policy evidence fact written by the policy observer snapshotter. */
export interface NulleditPolicyDecisionFactRecord {
  /** Record schema version. */
  version: 1;
  /** Stable deterministic fact id for idempotent observer replay. */
  factId: string;
  /** Root drop id whose branch accepted the policy evidence event. */
  rootDropId: string;
  /** Branch id that accepted the policy evidence event. */
  branchId: string;
  /** Snapshot id that accepted the policy evidence event. */
  snapshotId: number;
  /** Source diff event id carrying policy metadata. */
  sourceEventId: string;
  /** Durable source event sequence within the branch. */
  sourceSeq: number;
  /** Writer client id recorded on the source event. */
  sourceClientId: string;
  /** Stable external or sidecar reference to the policy decision, when present. */
  policyDecisionRef?: string;
  /** Source diff metadata kind. */
  metadataKind?: DropDiffEventKind;
  /** Source diff metadata intent. */
  intent?: string;
  /** Source diff metadata labels. */
  labels?: string[];
  /** Source diff metadata confidence. */
  confidence?: number;
  /** Source diff metadata args copied without interpretation. */
  args?: Record<string, JsonValue>;
  /** Queryable policy evidence summary. */
  text: string;
  /** Time the source diff event was created. */
  createdAt: number;
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

/** Runtime facts loaded by a platform adapter for runtime-ref heap materialization. */
export interface NulleditResolvedRuntimeFacts {
  /** UI response facts persisted for the branch runtime. */
  uiResponseFacts?: NullplugUiResponseFact[];
  /** UI state patch facts persisted for the branch runtime. */
  uiStatePatchFacts?: NullplugUiStatePatchFact[];
  /** UI state snapshots persisted for the branch runtime. */
  uiStateSnapshots?: NullplugUiStateSnapshot[];
}

/** Options for the built-in runtime-ref snapshotter. */
export interface NulleditResolvedRuntimeRefsSnapshotterOptions {
  /** Loads platform-specific nullplug runtime facts for the accepted snapshot. */
  loadRuntimeFacts?: (
    context: NulleditSnapshotContext,
  ) => Promise<NulleditResolvedRuntimeFacts> | NulleditResolvedRuntimeFacts;
}

/** Persists one derived priority fact for a Nulledit snapshotter. */
export type NulleditPriorityFactWriter = (
  fact: ResolvedPriorityFactRecord,
  context: NulleditSnapshotContext,
) => Promise<void> | void;

/** Options for the built-in diff-priority snapshotter. */
export interface NulleditDiffPrioritySnapshotterOptions {
  /** Writes the derived priority fact to the platform-specific priority store. */
  writePriorityFact: NulleditPriorityFactWriter;
}

/** Fact payload written by the NullMem observer snapshotter. */
export interface NulleditNullMemObservedAppendFact {
  /** Stable deterministic memory record id for idempotent replay. */
  recordId: string;
  /** Kind of source object this fact annotates. */
  targetKind: NullMemFactRecord["targetKind"];
  /** Id of the source object this fact annotates. */
  targetId: string;
  /** Short title shown in memory capsules. */
  title: string;
  /** Human-readable fact text for agent retrieval. */
  text: string;
  /** Retrieval labels for memory queries. */
  labels: string[];
  /** Retrieval priority for the observed append fact. */
  priority: number;
  /** Confidence assigned by the deterministic observer. */
  confidence: number;
  /** Primary branch, snapshot, and diff refs that justify this fact. */
  sourceRefs: NullMemSourceRef[];
  /** Compact structured append metadata. */
  metadata: Record<string, JsonValue>;
}

/** Persists one derived NullMem fact for a Nulledit snapshotter. */
export type NulleditNullMemFactWriter = (
  fact: NulleditNullMemObservedAppendFact,
  context: NulleditSnapshotContext,
) => Promise<void> | void;

/** Options for the built-in NullMem observer snapshotter. */
export interface NulleditNullMemObserverSnapshotterOptions {
  /** Writes the observed append fact to the platform-specific memory store. */
  writeFact: NulleditNullMemFactWriter;
}

/** Accepted branch commit summary passed to hot-path buffering policy. */
export interface BranchAcceptedCommit {
  /** Root drop id whose branch accepted events. */
  rootDropId: string;
  /** Branch id that accepted events. */
  branchId: string;
  /** Created snapshot id for the accepted events. */
  snapshotId: number;
  /** Previous branch head snapshot id. */
  parentSnapshotId: number | null;
  /** Updated branch record after primary persistence. */
  branch: DropBranchRecord;
  /** Snapshot record created by primary persistence. */
  snapshot: DropSnapshotRecord;
  /** Materialized branch content after the accepted events. */
  content: string;
  /** Accepted diff events with durable sequence and snapshot ids assigned. */
  acceptedEvents: DropDiffEvent[];
  /** Number of input events ignored because they were duplicates. */
  deduplicatedCount: number;
  /** Total number of stored branch events after the append. */
  totalStored: number;
}

/** Reasons a branch commit buffer can flush buffered derived work. */
export type BranchCommitFlushReason =
  | "event-threshold"
  | "byte-threshold"
  | "age-threshold"
  | "explicit-query"
  | "branch-idle"
  | "manual";

/** Decision returned by `BranchCommitBuffer` for derived snapshotter work. */
export type BranchCommitBufferDecision =
  | { mode: "write-through"; reason: "cold-branch" | "explicit-flush" }
  | {
      mode: "buffer";
      reason: "hot-branch";
      flushAfterMs: number;
      bufferedEventCount: number;
      bufferedByteCount?: number;
      flushReason?: BranchCommitFlushReason;
    }
  | { mode: "skip-derived"; reason: "up-to-date" };

/** Request to flush buffered commits for one branch. */
export interface BranchCommitFlushRequest {
  /** Root drop id whose branch buffer should flush. */
  rootDropId: string;
  /** Branch id whose buffer should flush. */
  branchId: string;
  /** Caller-visible reason for flushing. */
  reason: BranchCommitFlushReason;
}

/** Result returned after flushing buffered branch commits. */
export interface BranchCommitFlushResult {
  /** Root drop id whose branch buffer was flushed. */
  rootDropId: string;
  /** Branch id whose buffer was flushed. */
  branchId: string;
  /** Reason supplied for this flush. */
  reason: BranchCommitFlushReason;
  /** Buffered commits returned in append order. */
  commits: BranchAcceptedCommit[];
  /** Total accepted events represented by returned commits. */
  bufferedEventCount: number;
  /** Estimated byte count represented by returned commits. */
  bufferedByteCount: number;
  /** Latest snapshot id represented by returned commits, or null when empty. */
  latestSnapshotId: number | null;
}

/** Request to drop buffered state for one branch without materializing it. */
export interface BranchCacheInvalidation {
  /** Root drop id whose branch buffer should be invalidated. */
  rootDropId: string;
  /** Branch id whose buffer should be invalidated. */
  branchId: string;
  /** Optional caller-visible invalidation reason. */
  reason?: string;
}

/** Policy seam that keeps derived snapshotter writes cold for hot branches. */
export interface BranchCommitBuffer {
  /** Records an accepted primary branch commit and decides derived write mode. */
  appendAcceptedCommit(
    commit: BranchAcceptedCommit,
  ): Promise<BranchCommitBufferDecision> | BranchCommitBufferDecision;
  /** Flushes buffered commits when a threshold, explicit query, or idle signal fires. */
  flush?(
    request: BranchCommitFlushRequest,
  ): Promise<BranchCommitFlushResult> | BranchCommitFlushResult;
  /** Invalidates buffered branch state without materializing derived records. */
  invalidate?(input: BranchCacheInvalidation): Promise<void> | void;
}

/** Thresholds used by the in-memory branch commit buffer. */
export interface BranchCommitBufferThresholds {
  /** Accepted event count after which a branch is considered hot. Defaults to 2. */
  hotBranchEventCount?: number;
  /** Buffered event count that should request an immediate flush. */
  maxBufferedEventCount?: number;
  /** Estimated buffered bytes that should request an immediate flush. */
  maxBufferedBytes?: number;
  /** Oldest buffered commit age that should request an immediate flush. */
  maxBufferedAgeMs?: number;
  /** Idle duration callers may use when scheduling branch-idle flushes. */
  branchIdleMs?: number;
  /** Default delay advertised while buffering below thresholds. Defaults to 250ms. */
  flushAfterMs?: number;
}

/** Options for `createInMemoryBranchCommitBuffer`. */
export interface InMemoryBranchCommitBufferOptions {
  /** Threshold policy used to classify hot branches and request flushes. */
  thresholds?: BranchCommitBufferThresholds;
  /** Clock override for deterministic tests. */
  now?: () => number;
  /** Commit-size estimator override for tests or alternate runtimes. */
  estimateCommitBytes?: (commit: BranchAcceptedCommit) => number;
}

/** Phase hint for ordering Nulledit snapshotters in the append pipeline. */
export type NulleditSnapshotterPhase = "primary" | "secondary" | "extended";

/** Request passed to a snapshotter's yieldNext for "next n" results. */
export interface NulleditNextRequest {
  query?: string;
  top?: number;
  maxTokens?: number;
  preview?: boolean;
  labels?: string[];
}

/** Result returned by snapshotter yieldNext. */
export interface NulleditNextResult {
  items: unknown[];
  truncated?: boolean;
  nextCursor?: string;
}

/** A Nulledit snapshotter derives and stores state for an accepted snapshot. */
export interface NulleditSnapshotter {
  /** Stable snapshotter identifier used in logs and errors. */
  id: string;
  /** Optional phase hint. Snapshotters default to `extended`. */
  phase?: NulleditSnapshotterPhase;
  /** Runs after the branch snapshot has committed. */
  snapshot(context: NulleditSnapshotContext): Promise<void> | void;
  /** Optional lightweight "next n" projection for MCP/CLI responses. */
  yieldNext?(request?: NulleditNextRequest): NulleditNextResult | Promise<NulleditNextResult>;
}

/** Function returned after registering a persistent Nulledit snapshotter. */
export type NulleditSnapshotterUnsubscribe = () => void;

/** Registry of persistent Nulledit snapshotters for a provider instance. */
export interface NulleditSnapshotterRegistry {
  /** Registers a persistent snapshotter and returns an unsubscribe function. */
  register(snapshotter: NulleditSnapshotter): NulleditSnapshotterUnsubscribe;
  /** Returns a defensive copy of registered snapshotters in registration order. */
  list(): NulleditSnapshotter[];
  /** Invoke yieldNext on a specific snapshotter by id (if it implements it). */
  yieldNext?(id: string, request?: NulleditNextRequest): NulleditNextResult | Promise<NulleditNextResult> | undefined;
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

/** Options for dispatching snapshotters from a buffered branch commit. */
export interface BranchCommitSnapshotterDispatchOptions
  extends NulleditSnapshotterDispatchOptions {
  /** Functional datastore used by derived snapshotters. */
  data: VoidDataStore;
}

/** Options for flushing a `BranchCommitBuffer` into derived snapshotters. */
export interface BranchCommitBufferSnapshotterFlushOptions
  extends BranchCommitSnapshotterDispatchOptions {
  /** Buffer that owns the branch commit queue. */
  commitBuffer: BranchCommitBuffer;
  /** Root drop id whose branch buffer should flush. */
  rootDropId: string;
  /** Branch id whose buffer should flush. */
  branchId: string;
  /** Caller-visible reason for materializing buffered derived work. */
  reason: BranchCommitFlushReason;
}

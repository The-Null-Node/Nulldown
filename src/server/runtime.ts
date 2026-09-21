import type {
  DropBranchRecord,
  DropSnapshotRecord,
} from "../../shared/drop/branch";
import type {
  DropDiffEvent,
  DropDiffEventAcknowledgement,
} from "../../shared/drop/diff";
import type {
  NulleditSnapshotter,
  NulleditSnapshotterDispatchOptions,
  NulleditSnapshotterUnsubscribe,
} from "./nulledit";
import type { NulleditNextRequest, NulleditNextResult } from "./nulledit/types";
import type { RuntimeDataStore } from "./ports";
import type {
  NullMemCapsule,
  NullMemFactRecord,
  NullMemFreshnessReport,
  NullMemProcedureStepProjection,
  NullMemProcedureRecord,
  NullMemQuery,
  NullMemRecord,
  NullMemSourceRef,
} from "../../shared/nullmem/types";
import type { JsonValue } from "../../shared/nullplug/types";
import type {
  NullplugRuntime,
  NullplugRuntimePolicy,
} from "../../shared/nullplug/runtime";

/** Request passed through the backend NulldownServerRuntime Nulledit service. */
export interface ServerNulleditAppendRequest extends NulleditSnapshotterDispatchOptions {
  /** Branch that should accept the diff events. */
  branch: DropBranchRecord;
  /** Diff events to deduplicate, sequence, persist, and snapshot. */
  events: DropDiffEvent[];
}

/** Result returned by the backend NulldownServerRuntime Nulledit service. */
export interface ServerNulleditAppendResult {
  /** Updated branch after the append, or current branch for fully deduplicated writes. */
  branch: DropBranchRecord;
  /** Created snapshot, or null when every input event was already stored. */
  snapshot: DropSnapshotRecord | null;
  /** Materialized branch content at the returned branch head. */
  content: string;
  /** Events accepted during this append with durable sequence numbers assigned. */
  acceptedEvents: DropDiffEvent[];
  /** Acknowledgements for new and idempotently replayed input events. */
  acknowledgements: DropDiffEventAcknowledgement[];
  /** Number of input events ignored because they were duplicates. */
  deduplicatedCount: number;
  /** Total number of branch events stored after the append. */
  totalStored: number;
}

/** Nulledit operations exposed through the backend NulldownServerRuntime. */
export interface ServerNulleditService {
  /** Appends diff events to a branch and dispatches Nulledit snapshotters. */
  appendDiffEvents(
    request: ServerNulleditAppendRequest,
  ): Promise<ServerNulleditAppendResult>;
  /** Registers a persistent secondary snapshotter for future branch appends. */
  registerSnapshotter(
    snapshotter: NulleditSnapshotter,
  ): NulleditSnapshotterUnsubscribe;
  /** Lightweight compact projection from a specific snapshotter (if it implements yieldNext). */
  yieldNext(
    snapshotterId: string,
    request?: NulleditNextRequest,
  ): NulleditNextResult | Promise<NulleditNextResult> | undefined;
}

/** Branch target used by BranchMemoryService operations. */
export interface BranchMemoryTarget {
  /** Canonical root drop id whose branch owns the memory. */
  rootDropId: string;
  /** Branch id whose memory records should be read or written. */
  branchId: string;
}

/** Request accepted by the backend server runtime memory service. */
export interface BranchMemoryQueryRequest extends BranchMemoryTarget {
  /** Optional text query used for strict lexical matching. */
  q?: string;
  /** Optional memory record kind filter. */
  kind?: NullMemRecord["kind"];
  /** Optional label filters that all returned records must contain. */
  labels?: string[];
  /** Maximum number of records to return. */
  limit?: number;
  /** When true, the implementation should also compute freshness for results. */
  includeFreshness?: boolean;
  /** Current branch head snapshot id to use when computing freshness. */
  currentSnapshotId?: number;
  /** Exact procedure record id for compact next-step projection. */
  procedureId?: string;
  /** Return steps with index greater than this cursor. */
  afterStep?: number;
  /** Maximum procedure steps to project. */
  stepLimit?: number;
  /** Whether full records should be returned alongside capsules. */
  includeRecords?: boolean;
}

/** Result returned by the backend server runtime memory service. */
export interface BranchMemoryQueryResult {
  /** Canonical root drop id whose branch memory was queried. */
  rootDropId: string;
  /** Branch id whose memory was queried. */
  branchId: string;
  /** Normalized query reflected back to callers. */
  query: NullMemQuery;
  /** Compact records intended for agent context routing. */
  capsules: NullMemCapsule[];
  /** Full matching memory records. */
  records: NullMemRecord[];
  /** Compact procedure step projections for atomic next-step execution. */
  procedureSteps?: NullMemProcedureStepProjection[];
  /** Optional freshness reports when requested. */
  freshness?: NullMemFreshnessReport[];
}

/** Input accepted when creating a BranchMemoryService fact record. */
export interface BranchMemoryFactInput {
  /** Optional caller-supplied deterministic record id. */
  recordId?: string;
  /** Optional kind for the thing this fact annotates. */
  targetKind?: NullMemFactRecord["targetKind"];
  /** Optional id for the thing this fact annotates. */
  targetId?: string;
  /** Optional short title used in capsules. */
  title?: string;
  /** Fact text to store. */
  text: string;
  /** Retrieval labels for the fact. */
  labels?: string[];
  /** Sorting priority for retrieval. */
  priority?: number;
  /** Confidence score for the fact. */
  confidence?: number;
  /** Source refs that justify or expand the fact. */
  sourceRefs?: NullMemSourceRef[];
  /** Optional structured metadata. */
  metadata?: Record<string, JsonValue>;
}

/** Request accepted by the backend server runtime memory service. */
export interface BranchMemoryFactRequest extends BranchMemoryTarget {
  /** Fact input to persist for the branch. */
  fact: BranchMemoryFactInput;
}

/** Input accepted when creating a BranchMemoryService procedure record. */
export interface BranchMemoryProcedureInput {
  /** Optional caller-supplied deterministic record id. */
  recordId?: string;
  /** Goal achieved by the procedure. */
  goal: string;
  /** Compact reusable summary. */
  summary: string;
  /** Ordered execution steps. */
  steps?: NullMemProcedureRecord["steps"];
  /** Procedure outcome. */
  outcome?: NullMemProcedureRecord["outcome"];
  /** Optional reuse category. */
  reusableAs?: string;
  /** Retrieval labels for the procedure. */
  labels?: string[];
  /** Sorting priority for retrieval. */
  priority?: number;
  /** Confidence score for the procedure. */
  confidence?: number;
  /** Source refs that justify or expand the procedure. */
  sourceRefs?: NullMemSourceRef[];
  /** Optional structured metadata. */
  metadata?: Record<string, JsonValue>;
}

/** Request accepted by the backend server runtime memory service. */
export interface BranchMemoryProcedureRequest extends BranchMemoryTarget {
  /** Procedure input to persist for the branch. */
  procedure: BranchMemoryProcedureInput;
}

/** Request accepted when deleting a branch-scoped memory record. */
export interface BranchMemoryDeleteRequest extends BranchMemoryTarget {
  /** Stable memory record id to delete. */
  recordId: string;
}

/** Result returned after a BranchMemoryService delete. */
export interface BranchMemoryDeleteResult {
  /** Canonical root drop id whose branch memory was touched. */
  rootDropId: string;
  /** Branch id whose memory was touched. */
  branchId: string;
  /** Stable memory record id requested for deletion. */
  recordId: string;
}

/** Result returned after a BranchMemoryService write. */
export interface BranchMemoryWriteResult<TRecord extends NullMemRecord> {
  /** Canonical root drop id whose branch memory was written. */
  rootDropId: string;
  /** Branch id whose memory was written. */
  branchId: string;
  /** Memory record that was written. */
  record: TRecord;
}

/** Memory operations exposed through the backend NulldownServerRuntime. */
export interface BranchMemoryService {
  /** Queries facts, procedures, and capabilities for a branch. */
  query(request: BranchMemoryQueryRequest): Promise<BranchMemoryQueryResult>;
  /** Creates a branch-scoped fact record. */
  createFact(
    request: BranchMemoryFactRequest,
  ): Promise<BranchMemoryWriteResult<NullMemFactRecord>>;
  /** Creates a branch-scoped procedure record. */
  createProcedure(
    request: BranchMemoryProcedureRequest,
  ): Promise<BranchMemoryWriteResult<NullMemProcedureRecord>>;
  /** Deletes a branch-scoped memory record by stable record id. */
  delete(request: BranchMemoryDeleteRequest): Promise<BranchMemoryDeleteResult>;
}

/** Backend server runtime composed from data, edit, memory, nullplug, and policy services. */
export interface NulldownServerRuntime {
  /** Functional persistence, indexing, caching, and locking boundary. */
  data: RuntimeDataStore;
  /** Shared edit, snapshot, and query engine. */
  nulledit: ServerNulleditService;
  /** Branch-scoped facts, procedures, and capability memory. */
  memory: BranchMemoryService;
  /** Server-runtime-owned nullplug invocation, normalization, and policy boundary. */
  nullplug: NullplugRuntime;
  /** Root-scoped runtime policy service used by nullplug invocation. */
  policy: NullplugRuntimePolicy;
}

/** Dependencies required to compose a backend NulldownServerRuntime. */
export interface CreateNulldownServerRuntimeOptions {
  /** Functional datastore implementation for the current platform. */
  data: RuntimeDataStore;
  /** Nulledit facade implementation for the current platform. */
  nulledit: ServerNulleditService;
  /** Memory facade implementation for the current platform. */
  memory: BranchMemoryService;
  /** Nullplug runtime implementation for the current platform. */
  nullplug: NullplugRuntime;
  /** Runtime policy implementation for the current platform. */
  policy: NullplugRuntimePolicy;
}

/** Creates a backend NulldownServerRuntime from its server capabilities. */
export const createNulldownServerRuntime = ({
  data,
  nulledit,
  memory,
  nullplug,
  policy,
}: CreateNulldownServerRuntimeOptions): NulldownServerRuntime => ({
  data,
  nulledit,
  memory,
  nullplug,
  policy,
});

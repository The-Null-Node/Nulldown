import type {
  DropBranchRecord,
  DropSnapshotRecord,
} from "../../shared/drop/branch";
import type { DropDiffEvent } from "../../shared/drop/diff";
import type {
  NulleditSnapshotterDispatchOptions,
} from "./nulledit";
import type { VoidDataStore } from "./ports";
import type {
  NullMemCapsule,
  NullMemFactRecord,
  NullMemProcedureRecord,
  NullMemQuery,
  NullMemRecord,
  NullMemSourceRef,
} from "../../shared/nullmem";
import type { JsonValue } from "../../shared/nullplug/types";

/** Request passed through the VoidProvider Nulledit append facade. */
export interface VoidProviderNulleditAppendRequest
  extends NulleditSnapshotterDispatchOptions {
  /** Branch that should accept the diff events. */
  branch: DropBranchRecord;
  /** Diff events to deduplicate, sequence, persist, and snapshot. */
  events: DropDiffEvent[];
}

/** Result returned by the VoidProvider Nulledit append facade. */
export interface VoidProviderNulleditAppendResult {
  /** Updated branch after the append, or current branch for fully deduplicated writes. */
  branch: DropBranchRecord;
  /** Created snapshot, or null when every input event was already stored. */
  snapshot: DropSnapshotRecord | null;
  /** Materialized branch content at the returned branch head. */
  content: string;
  /** Events accepted during this append with durable sequence numbers assigned. */
  acceptedEvents: DropDiffEvent[];
  /** Number of input events ignored because they were duplicates. */
  deduplicatedCount: number;
  /** Total number of branch events stored after the append. */
  totalStored: number;
}

/** Nulledit operations exposed through the app-facing VoidProvider facade. */
export interface VoidProviderNulledit {
  /** Appends diff events to a branch and dispatches Nulledit snapshotters. */
  appendDiffEvents(
    request: VoidProviderNulleditAppendRequest,
  ): Promise<VoidProviderNulleditAppendResult>;
}

/** Branch target used by VoidMemory operations. */
export interface VoidMemoryBranchTarget {
  /** Canonical root drop id whose branch owns the memory. */
  rootDropId: string;
  /** Branch id whose memory records should be read or written. */
  branchId: string;
}

/** Request accepted by the VoidProvider memory query facade. */
export interface VoidMemoryQueryRequest extends VoidMemoryBranchTarget {
  /** Optional text query used for strict lexical matching. */
  q?: string;
  /** Optional memory record kind filter. */
  kind?: NullMemRecord["kind"];
  /** Optional label filters that all returned records must contain. */
  labels?: string[];
  /** Maximum number of records to return. */
  limit?: number;
}

/** Result returned by the VoidProvider memory query facade. */
export interface VoidMemoryQueryResult {
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
}

/** Input accepted when creating a VoidMemory fact record. */
export interface VoidMemoryFactInput {
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

/** Request accepted by the VoidProvider memory fact facade. */
export interface VoidMemoryFactRequest extends VoidMemoryBranchTarget {
  /** Fact input to persist for the branch. */
  fact: VoidMemoryFactInput;
}

/** Input accepted when creating a VoidMemory procedure record. */
export interface VoidMemoryProcedureInput {
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

/** Request accepted by the VoidProvider memory procedure facade. */
export interface VoidMemoryProcedureRequest extends VoidMemoryBranchTarget {
  /** Procedure input to persist for the branch. */
  procedure: VoidMemoryProcedureInput;
}

/** Result returned after a VoidMemory write. */
export interface VoidMemoryWriteResult<TRecord extends NullMemRecord> {
  /** Canonical root drop id whose branch memory was written. */
  rootDropId: string;
  /** Branch id whose memory was written. */
  branchId: string;
  /** Memory record that was written. */
  record: TRecord;
}

/** Memory operations exposed through the app-facing server VoidProvider facade. */
export interface VoidMemory {
  /** Queries facts, procedures, and capabilities for a branch. */
  query(request: VoidMemoryQueryRequest): Promise<VoidMemoryQueryResult>;
  /** Creates a branch-scoped fact record. */
  createFact(
    request: VoidMemoryFactRequest,
  ): Promise<VoidMemoryWriteResult<NullMemFactRecord>>;
  /** Creates a branch-scoped procedure record. */
  createProcedure(
    request: VoidMemoryProcedureRequest,
  ): Promise<VoidMemoryWriteResult<NullMemProcedureRecord>>;
}

/** App-facing server facade composed from storage, crypto, and Nulledit services. */
export interface VoidProvider {
  /** Functional persistence, indexing, caching, and locking boundary. */
  data: VoidDataStore;
  /** Shared edit, snapshot, and query engine. */
  nulledit: VoidProviderNulledit;
  /** Branch-scoped facts, procedures, and capability memory. */
  memory: VoidMemory;
}

/** Dependencies required to compose a VoidProvider. */
export interface CreateVoidProviderOptions {
  /** Functional datastore implementation for the current platform. */
  data: VoidDataStore;
  /** Nulledit facade implementation for the current platform. */
  nulledit: VoidProviderNulledit;
  /** Memory facade implementation for the current platform. */
  memory: VoidMemory;
}

/** Creates the app-facing VoidProvider facade from platform-neutral capabilities. */
export const createVoidProvider = ({
  data,
  nulledit,
  memory,
}: CreateVoidProviderOptions): VoidProvider => ({
  data,
  nulledit,
  memory,
});

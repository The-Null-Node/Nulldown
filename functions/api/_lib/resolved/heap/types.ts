import type { AccountAuthEnv } from "../../accounts/session/auth";
import {
  RESOLVED_DOCUMENT_RESOLVER_ID,
  RESOLVED_RUNTIME_REFS_RESOLVER_ID,
} from "../../../../../shared/drop/resolved/constants";
import type { ResolvedPriorityFactRecord } from "../../../../../shared/drop/resolved/types";
import type {
  NullplugUiPrimitive,
  NullplugUiResponseFact,
  NullplugUiStatePatchFact,
  NullplugUiStateSnapshot,
} from "../../../../../shared/nullplug/ui";
import type {
  VoidBlobStore,
  VoidSqlStore,
} from "../../../../../src/server/ports";

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

/** Route parameters for deleting one branch-scoped resolved priority fact. */
export interface ResolvedPriorityFactDeleteParams extends ResolvedHeapParams {
  factId: string | string[];
}

/** Branch state required by resolved heap route handlers. */
export interface ResolvedBranchTarget {
  rootDropId: string;
  branchId: string;
  branch: {
    headSnapshotId: number;
    headEventSeq?: number | null;
    ownerAccountId?: string | null;
    writerAccountId?: string | null;
  };
}

/** Target supplied when a resolved query should repair cold derived state first. */
export interface ResolvedHeapQueryRepairTarget {
  /** Canonical root drop id for the queried branch. */
  rootDropId: string;
  /** Branch id whose latest derived state should be materialized. */
  branchId: string;
  /** Latest branch snapshot id requested by the query. */
  snapshotId: number;
  /** Resolver id requested by the query. */
  resolverId: string;
}

/** Optional services used by resolved heap queries. */
export interface ResolvedHeapQueryOptions {
  /** Flushes cold-path derived state before querying the latest snapshot. */
  repairBufferedCommits?: (
    target: ResolvedHeapQueryRepairTarget,
  ) => Promise<void> | void;
  /** Observes repair failures without failing the query. */
  onRepairError?: (error: unknown, target: ResolvedHeapQueryRepairTarget) => void;
}

/** Parsed request payload for rebuilding one or more resolved heap projections. */
export interface ResolvedUpdateRequest {
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

/** Parsed request payload for creating one resolved priority fact. */
export interface ResolvedPriorityFactRequest {
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

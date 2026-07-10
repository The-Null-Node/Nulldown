import type { JsonValue } from "../nullplug/types";

export const NULLMEM_RECORD_VERSION = 1 as const;

/** Stable source reference used by NullMem records to cite primary evidence. */
export type NullMemSourceRef =
  | { kind: "drop"; rootDropId: string }
  | { kind: "branch"; rootDropId: string; branchId: string }
  | {
      kind: "snapshot";
      rootDropId: string;
      branchId: string;
      snapshotId: number;
    }
  | {
      kind: "diff";
      rootDropId: string;
      branchId: string;
      eventId: string;
      seq?: number;
    }
  | {
      kind: "node";
      rootDropId: string;
      branchId: string;
      resolverId: string;
      nodeId: string;
    }
  | {
      kind: "heap";
      rootDropId: string;
      branchId: string;
      resolverId: string;
      snapshotId: number;
    }
  | { kind: "nullplug"; pluginId: string; version?: string }
  | { kind: "tool"; toolId: string }
  | { kind: "theme"; themeId: string }
  | { kind: "mcp"; toolId: string };

/** Example attached to a capability to help agents decide how to use it. */
export interface NullMemCapabilityExample {
  title?: string;
  input?: JsonValue;
  output?: JsonValue;
  summary?: string;
}

/** Queryable capability memory for nullplugs, tools, themes, and future MCP tools. */
export interface NullMemCapabilityRecord {
  version: typeof NULLMEM_RECORD_VERSION;
  kind: "capability";
  recordId: string;
  capabilityKind: "nullplug" | "tool" | "theme" | "mcp";
  capabilityId: string;
  capabilityVersion?: string;
  title?: string;
  description: string;
  inputSchema?: JsonValue;
  outputSchema?: JsonValue;
  permissions?: JsonValue[];
  whenToUse?: string[];
  whenNotToUse?: string[];
  examples?: NullMemCapabilityExample[];
  labels?: string[];
  priority?: number;
  confidence?: number;
  sourceRefs?: NullMemSourceRef[];
  createdAt: number;
  updatedAt?: number;
  metadata?: Record<string, JsonValue>;
}

/** One step in a reusable procedure or reasoning trace. */
export interface NullMemProcedureCallHint {
  /** Runtime surface that can execute this step. */
  target: "tool" | "mcp" | "cli" | "nullplug";
  /** Tool, command, nullplug, or MCP method name to call. */
  name: string;
  /** Compact JSON argument hints for the call. */
  args?: Record<string, JsonValue>;
  /** Human-readable argument summary when exact args depend on prior results. */
  argsSummary?: string;
}

export interface NullMemProcedureStep {
  index: number;
  kind:
    | "tool.call"
    | "nullplug.call"
    | "mcp.call"
    | "diff.apply"
    | "query"
    | "deploy"
    | "test"
    | "note";
  name: string;
  description?: string;
  argsSummary?: string;
  callHint?: NullMemProcedureCallHint;
  exitCondition?: string;
  minStep?: boolean;
  resultSummary?: string;
  status: "success" | "failed" | "skipped" | "partial";
  refs?: NullMemSourceRef[];
}

/** Compact next-step projection for executing procedures atomically. */
export interface NullMemProcedureStepProjection {
  procedureId: string;
  goal: string;
  summary: string;
  step: NullMemProcedureStep;
  nextCursor?: number;
  remainingSteps: number;
}

/** Reusable procedure memory that records how a goal was achieved. */
export interface NullMemProcedureRecord {
  version: typeof NULLMEM_RECORD_VERSION;
  kind: "procedure";
  recordId: string;
  rootDropId?: string;
  branchId?: string;
  goal: string;
  summary: string;
  steps: NullMemProcedureStep[];
  outcome: "success" | "partial" | "failed";
  reusableAs?: string;
  labels?: string[];
  priority?: number;
  confidence?: number;
  sourceRefs?: NullMemSourceRef[];
  createdAt: number;
  updatedAt?: number;
  metadata?: Record<string, JsonValue>;
}

/** Branch-scoped memory annotation that does not mutate primary markdown. */
export interface NullMemFactRecord {
  version: typeof NULLMEM_RECORD_VERSION;
  kind: "fact";
  recordId: string;
  rootDropId?: string;
  branchId?: string;
  targetKind?: NullMemSourceRef["kind"] | "custom";
  targetId?: string;
  title?: string;
  text: string;
  labels?: string[];
  priority?: number;
  confidence?: number;
  sourceRefs?: NullMemSourceRef[];
  createdAt: number;
  updatedAt?: number;
  metadata?: Record<string, JsonValue>;
}

/** Any persisted or built-in NullMem record. */
export type NullMemRecord =
  | NullMemCapabilityRecord
  | NullMemProcedureRecord
  | NullMemFactRecord;

/** Query shape for retrieving mixed NullMem capsules. */
export interface NullMemQuery {
  q?: string;
  kind?: NullMemRecord["kind"];
  labels?: string[];
  limit?: number;
  /** Exact procedure record id when requesting next-step projections. */
  procedureId?: string;
  /** Return steps with index greater than this cursor. */
  afterStep?: number;
  /** Maximum procedure steps to project. Defaults to 1 when step projection is requested. */
  stepLimit?: number;
}

/** Compact result returned to agents before expanding full source refs. */
export interface NullMemCapsule {
  recordId: string;
  kind: NullMemRecord["kind"];
  title?: string;
  summary: string;
  labels?: string[];
  priority?: number;
  confidence?: number;
  sourceRefs?: NullMemSourceRef[];
  record: NullMemRecord;
}

/** Freshness status for a NullMem record relative to its cited sources. */
export type NullMemFreshnessStatus =
  | "fresh"
  | "explicit-stale"
  | "superseded"
  | "snapshot-outdated"
  | "source-missing"
  | "needs-review"
  | "unverifiable";

/** Report describing the freshness evaluation for a single memory record. */
export interface NullMemFreshnessReport {
  /** Stable record identifier. */
  recordId: string;
  /** Current freshness status. */
  status: NullMemFreshnessStatus;
  /** Human-readable explanation of the status. */
  reason: string;
  /** Snapshot id considered current when the check ran (if known). */
  currentSnapshotId?: number;
  /** Snapshot ids cited by the record that are older than the current head. */
  outdatedSnapshotRefs?: number[];
  /** Record ids that explicitly supersede this record (from labels). */
  supersededBy?: string[];
  /** Whether the record carries an explicit stale marker. */
  hasStaleLabel: boolean;
  /** Whether the record has at least one usable source ref. */
  hasSourceRefs: boolean;
}

/** Options controlling a freshness evaluation. */
export interface NullMemFreshnessOptions {
  /** Current branch head snapshot id for the evaluated branch. */
  currentSnapshotId?: number;
  /** Additional snapshot heads to consider when evaluating snapshot refs. */
  snapshotHeads?: Record<string, number>;
  /** Records already known to be superseded (used for cross-record checks). */
  knownSupersedingIds?: string[];
}

/** Input bundle used to evaluate freshness for a batch of records. */
export interface NullMemFreshnessInput {
  /** Records to evaluate. */
  records: NullMemRecord[];
  /** Current branch snapshot id for the owning branch. */
  currentSnapshotId?: number;
  /** Snapshot heads keyed by "root:branch" for cross-branch refs. */
  snapshotHeads?: Record<string, number>;
  /** Known superseding record ids from prior checks. */
  knownSupersedingIds?: string[];
}

/** Result of a batch freshness evaluation. */
export interface NullMemFreshnessResult {
  /** Per-record freshness reports in the same order as input records. */
  reports: NullMemFreshnessReport[];
  /** Map of recordId -> report for quick lookup. */
  byRecordId: Record<string, NullMemFreshnessReport>;
}

/** Request accepted when evaluating freshness for a branch-scoped memory query. */
export interface NullMemFreshnessQueryRequest {
  /** Root drop id for the memory branch being evaluated. */
  rootDropId: string;
  /** Branch id whose memory records are being evaluated. */
  branchId: string;
  /** Text or label filters to narrow the records evaluated. */
  q?: string;
  kind?: NullMemRecord["kind"];
  labels?: string[];
  /** Maximum records to evaluate. */
  limit?: number;
  /** Whether to include full records in the response. */
  includeRecords?: boolean;
}

/** Result returned for a freshness query. */
export interface NullMemFreshnessQueryResult {
  /** Branch target evaluated. */
  rootDropId: string;
  branchId: string;
  /** Query used to select records. */
  query: NullMemQuery;
  /** Freshness reports for the matching records. */
  reports: NullMemFreshnessReport[];
  /** Full records when requested. */
  records?: NullMemRecord[];
  /** Capsules when records are returned. */
  capsules?: NullMemCapsule[];
  /** Compact procedure steps when a procedure cursor query is requested. */
  procedureSteps?: NullMemProcedureStepProjection[];
}

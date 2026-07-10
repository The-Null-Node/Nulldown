import type { DropBranchRecord } from "./branch";
import type { DropDiffEnvelope, DropDiffRef } from "./diff";
import type { DropMetadata } from "./types";
import type {
  JsonValue,
  NullplugDiagnostic,
  NullplugMutation,
  NullplugYield,
} from "../nullplug/types";
import type { NullplugUiPrimitive } from "../nullplug/ui";

/** Provider scope used by frontend runtime adapters. */
export type DropRuntimeProviderScope = "local" | "remote";

/** Version handle used by compare, append, render, and update flows. */
export interface DropRuntimeVersionRef {
  /** Root drop id for the branch timeline. */
  rootDropId: string;
  /** Branch id that owns the version. */
  branchId: string;
  /** Materialized snapshot id, when the version is snapshot-backed. */
  snapshotId?: number;
  /** Latest accepted event sequence known to the caller. */
  eventSeq?: number | null;
  /** Optional content hash for cheap equality checks. */
  contentHash?: string;
  /** Optional metadata hash for visibility, policy, theme, and provider settings. */
  metadataHash?: string;
  /** Optional runtime heap hash for nullplug/resolved fact equality checks. */
  runtimeHeapHash?: string;
}

/** Sync comparison state between local editor state and provider-backed state. */
export type DropRuntimeCompareStatus =
  | "equal"
  | "local-ahead"
  | "remote-ahead"
  | "diverged"
  | "metadata-diverged"
  | "heap-diverged"
  | "unknown";

/** Result of comparing an editor version with a provider version. */
export interface DropRuntimeCompareResult {
  /** Overall comparison status used by sync/update guard UX. */
  status: DropRuntimeCompareStatus;
  /** Version currently visible in the editor. */
  local: DropRuntimeVersionRef | null;
  /** Version currently known by the provider. */
  remote: DropRuntimeVersionRef | null;
  /** Optional provider branch metadata used for ownership and conflict messages. */
  branch?: DropBranchRecord | null;
  /** Human-readable reasons explaining non-equal states. */
  reasons?: string[];
}

/** Dirty-state source consumed by one user-facing update transaction. */
export type DropRuntimeDirtyField =
  | "content"
  | "metadata"
  | "visibility"
  | "provider-mode"
  | "runtime-facts"
  | "theme"
  | "nullplug-state";

/** User-facing action selected from compare and dirty-state results. */
export type DropRuntimeUpdateAction =
  | "share"
  | "update"
  | "synced"
  | "queue-update"
  | "fork"
  | "clone"
  | "resolve-conflict";

/** One progress step in a provider update transaction. */
export interface DropRuntimeUpdateStep {
  /** Stable step id, for example `content.diff` or `runtime-facts.write`. */
  id: string;
  /** Short UI label. */
  label: string;
  /** Current step state. */
  status: "pending" | "running" | "complete" | "failed";
  /** Optional failure or skip reason. */
  reason?: string;
}

/** Planned update transaction derived before mutating a provider. */
export interface DropRuntimeUpdatePlan {
  /** User-facing action for the primary editor button. */
  action: DropRuntimeUpdateAction;
  /** Provider that will receive the transaction. */
  provider: DropRuntimeProviderScope;
  /** Fields that make the editor dirty. */
  dirtyFields: DropRuntimeDirtyField[];
  /** Latest compare result used to choose the action. */
  compare: DropRuntimeCompareResult;
  /** Ordered transaction steps. */
  steps: DropRuntimeUpdateStep[];
}

/** Append request produced by editor or runtime adapters. */
export interface DropRuntimeAppendRequest {
  /** Version the caller believes it is appending from. */
  baseVersion: DropRuntimeVersionRef;
  /** Full markdown content after local edits. */
  content: string;
  /** Optional metadata patch to commit with the content update. */
  metadata?: DropMetadata;
  /** Optional precomputed diff envelope. */
  envelope?: DropDiffEnvelope;
}

/** Append result returned by a local or remote runtime adapter. */
export interface DropRuntimeAppendResult {
  /** Accepted provider scope. */
  provider: DropRuntimeProviderScope;
  /** New version after append. */
  version: DropRuntimeVersionRef;
  /** Diff events accepted by the provider. */
  acceptedDiffRefs: DropDiffRef[];
  /** Whether the append was stored immediately or queued for later sync. */
  status: "accepted" | "queued";
}

/** Stable pointer to a nullplug resolution artifact. */
export interface DropRuntimeNullplugResolutionRef {
  /** Root drop id that owns the render or runtime fact. */
  rootDropId: string;
  /** Branch id that owns the render or runtime fact. */
  branchId: string;
  /** Snapshot id used during resolution, when known. */
  snapshotId?: number;
  /** Nullplug plugin id. */
  pluginId: string;
  /** Nullplug call id. */
  callId: string;
  /** Optional durable response or state key. */
  resultKey?: string;
}

/** Structured nullplug runtime state produced by a render frame. */
export interface DropRuntimeNullplugRenderState {
  /** UI primitives emitted by nullplug calls. */
  uiPrimitives: NullplugUiPrimitive[];
  /** Path-keyed UI state. */
  uiState: Record<string, JsonValue>;
  /** Proposed runtime mutations. */
  mutations: NullplugMutation[];
  /** Values yielded by nullplug execution. */
  yields: NullplugYield[];
  /** Diagnostics emitted during resolution. */
  diagnostics: NullplugDiagnostic[];
  /** Call ids included in the render. */
  callIds: string[];
  /** Durable refs for resolved nullplug artifacts. */
  resolutionRefs?: DropRuntimeNullplugResolutionRef[];
}

/** Render-frame provenance for the latest winning editor render. */
export interface DropRuntimeRenderFrame {
  /** Stable frame id chosen by the renderer. */
  frameId: string;
  /** Root drop id, when rendering a branch-backed drop. */
  rootDropId?: string;
  /** Branch id, when rendering a branch-backed drop. */
  branchId?: string;
  /** Snapshot id or local version number used by the frame. */
  versionId?: number;
  /** Original markdown source. */
  sourceMarkdown: string;
  /** Markdown after nullplug/runtime resolution. */
  renderedMarkdown: string;
  /** Hash of original source. */
  sourceContentHash: string;
  /** Hash of rendered markdown. */
  renderedContentHash: string;
  /** Diff events accepted before this frame won. */
  acceptedDiffRefs: DropDiffRef[];
  /** Durable resolver refs included in the render. */
  resolverRefs: string[];
  /** Nullplug call ids included in the render. */
  nullplugCallIds: string[];
  /** Diagnostics emitted while rendering. */
  diagnostics: NullplugDiagnostic[];
  /** Current frame status. */
  status: "rendering" | "final" | "stale" | "error";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Checks whether a value is a frontend provider runtime scope. */
export const isDropRuntimeProviderScope = (
  value: unknown,
): value is DropRuntimeProviderScope => value === "local" || value === "remote";

/** Checks whether a value is a sync comparison status. */
export const isDropRuntimeCompareStatus = (
  value: unknown,
): value is DropRuntimeCompareStatus =>
  value === "equal" ||
  value === "local-ahead" ||
  value === "remote-ahead" ||
  value === "diverged" ||
  value === "metadata-diverged" ||
  value === "heap-diverged" ||
  value === "unknown";

/** Checks whether a serialized value can identify one runtime version. */
export const isDropRuntimeVersionRef = (
  value: unknown,
): value is DropRuntimeVersionRef => {
  if (!isRecord(value)) return false;
  if (typeof value.rootDropId !== "string") return false;
  if (typeof value.branchId !== "string") return false;
  if (
    value.snapshotId !== undefined &&
    (typeof value.snapshotId !== "number" || !Number.isFinite(value.snapshotId))
  ) {
    return false;
  }
  if (
    value.eventSeq !== undefined &&
    value.eventSeq !== null &&
    (typeof value.eventSeq !== "number" || !Number.isFinite(value.eventSeq))
  ) {
    return false;
  }
  return (
    (value.contentHash === undefined || typeof value.contentHash === "string") &&
    (value.metadataHash === undefined || typeof value.metadataHash === "string") &&
    (value.runtimeHeapHash === undefined ||
      typeof value.runtimeHeapHash === "string")
  );
};

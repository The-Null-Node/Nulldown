/*
These types describe the remote branch heap persisted by Pages Functions. They are not
just API shapes: the same records are stored in R2 and replayed to rebuild branch
content, so validation here protects both transport and storage integrity.
*/

/** Account-id request header used by branch and memory APIs in account-scoped flows. */
export const NULLDOWN_ACCOUNT_ID_HEADER = "x-nulldown-account-id";

/** Branch ownership mode. */
export type DropBranchMode = "owner" | "clone";
/** Lifecycle status for a writable branch. */
export type DropBranchStatus = "active" | "promoted" | "archived";

/*
`headSnapshotId` points at the latest materialized branch state. Event sequencing is
tracked separately so the branch can rebuild content from checkpoints plus diff ranges.
*/
export interface DropBranchRecord {
  /** Branch record schema version. */
  version: 1;
  /** Stable branch id, usually `owner` or an account/client clone id. */
  branchId: string;
  /** Root drop id whose content anchors this branch. */
  rootDropId: string;
  /** Drop id used as the branch's initial content. */
  baseDropId: string;
  /** Branch ownership mode. */
  mode: DropBranchMode;
  /** Current branch lifecycle state. */
  status: DropBranchStatus;
  /** Account that owns the root drop, if known. */
  ownerAccountId: string | null;
  /** Account allowed to write this branch, if account-scoped. */
  writerAccountId: string | null;
  /** Client id allowed to write this branch, if client-scoped. */
  writerClientId: string | null;
  /** Latest materialized snapshot id. */
  headSnapshotId: number;
  /** Snapshot heap layout version used by the branch. */
  snapshotHeapVersion?: number;
  /** Latest durable event sequence accepted by this branch. */
  headEventSeq?: number | null;
  /** Snapshot interval used for checkpoint creation. */
  checkpointInterval?: number;
  /** Creation time in epoch milliseconds. */
  createdAt: number;
  /** Last update time in epoch milliseconds. */
  updatedAt: number;
}

/** Materialized branch snapshot record stored in D1/R2. */
export interface DropSnapshotRecord {
  /** Snapshot record schema version. */
  version: 1;
  /** Snapshot id within the branch. */
  snapshotId: number;
  /** Root drop id whose branch produced this snapshot. */
  rootDropId: string;
  /** Branch id that produced this snapshot. */
  branchId: string;
  /** Parent snapshot id, or null for the initial snapshot. */
  parentSnapshotId: number | null;
  /** Snapshot sequence value used by branch replay/checkpoint logic. */
  seq: number;
  /** Event ids accepted into this snapshot. */
  eventIds: string[];
  /** Whether this snapshot has a full text checkpoint. */
  checkpointed: boolean;
  /** First event sequence included in the patch range. */
  patchStartSeq?: number | null;
  /** Last event sequence included in the patch range. */
  patchEndSeq?: number | null;
  /** Blob key for the full checkpoint text, when checkpointed. */
  checkpointKey?: string;
  /** Materialized text length. */
  textLength: number;
  /** Creation time in epoch milliseconds. */
  createdAt: number;
}

/** Response returned when resolving or creating the current writer branch. */
export interface DropBranchResolveResponse {
  /** Canonical root drop id. */
  rootDropId: string;
  /** Resolved branch id. */
  branchId: string;
  /** Branch mode. */
  mode: DropBranchMode;
  /** Whether the branch was created by this request. */
  created: boolean;
  /** Current head snapshot id. */
  headSnapshotId: number;
  /** Root owner account id, if known. */
  ownerAccountId: string | null;
  /** Writer account id, if account-scoped. */
  writerAccountId: string | null;
}

/** Response containing materialized branch content at a snapshot. */
export interface DropBranchContentResponse {
  /** Canonical root drop id. */
  rootDropId: string;
  /** Branch id. */
  branchId: string;
  /** Materialized snapshot id. */
  snapshotId: number;
  /** Snapshot content. */
  content: string;
}

/** Response listing branch snapshots. */
export interface DropSnapshotListResponse {
  /** Canonical root drop id. */
  rootDropId: string;
  /** Branch id. */
  branchId: string;
  /** Snapshot records ordered by the route/service implementation. */
  snapshots: DropSnapshotRecord[];
}

/** Response returned after promoting a branch snapshot to a new drop. */
export interface DropBranchPromoteResponse {
  /** New promoted drop id. */
  dropId: string;
  /** Public/editor URL for the promoted drop. */
  url: string;
  /** Root drop id of the source branch. */
  rootDropId: string;
  /** Source branch id. */
  branchId: string;
  /** Promoted snapshot id. */
  snapshotId: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isString = (value: unknown): value is string => typeof value === "string";

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Returns true when `value` is a valid persisted branch record. */
export const isDropBranchRecord = (
  value: unknown,
): value is DropBranchRecord => {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (!isString(value.branchId)) return false;
  if (!isString(value.rootDropId)) return false;
  if (!isString(value.baseDropId)) return false;
  if (value.mode !== "owner" && value.mode !== "clone") return false;
  if (
    value.status !== "active" &&
    value.status !== "promoted" &&
    value.status !== "archived"
  ) {
    return false;
  }
  if (!isNullableString(value.ownerAccountId)) return false;
  if (!isNullableString(value.writerAccountId)) return false;
  if (!isNullableString(value.writerClientId)) return false;
  return (
    isNumber(value.headSnapshotId) &&
    (value.snapshotHeapVersion === undefined ||
      isNumber(value.snapshotHeapVersion)) &&
    (value.headEventSeq === undefined ||
      value.headEventSeq === null ||
      isNumber(value.headEventSeq)) &&
    (value.checkpointInterval === undefined ||
      isNumber(value.checkpointInterval)) &&
    isNumber(value.createdAt) &&
    isNumber(value.updatedAt)
  );
};

/** Returns true when `value` is a valid persisted branch snapshot record. */
export const isDropSnapshotRecord = (
  value: unknown,
): value is DropSnapshotRecord => {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (!isNumber(value.snapshotId)) return false;
  if (!isString(value.rootDropId)) return false;
  if (!isString(value.branchId)) return false;
  if (value.parentSnapshotId !== null && !isNumber(value.parentSnapshotId)) {
    return false;
  }
  if (!isNumber(value.seq)) return false;
  if (
    !Array.isArray(value.eventIds) ||
    !value.eventIds.every((entry) => isString(entry))
  ) {
    return false;
  }
  if (typeof value.checkpointed !== "boolean") return false;
  if (
    value.patchStartSeq !== undefined &&
    value.patchStartSeq !== null &&
    !isNumber(value.patchStartSeq)
  ) {
    return false;
  }
  if (
    value.patchEndSeq !== undefined &&
    value.patchEndSeq !== null &&
    !isNumber(value.patchEndSeq)
  ) {
    return false;
  }
  if (value.checkpointKey !== undefined && !isString(value.checkpointKey)) {
    return false;
  }
  return isNumber(value.textLength) && isNumber(value.createdAt);
};

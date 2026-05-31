/*
These types describe the remote branch heap persisted by Pages Functions. They are not
just API shapes: the same records are stored in R2 and replayed to rebuild branch
content, so validation here protects both transport and storage integrity.
*/

export const NULLDOWN_ACCOUNT_ID_HEADER = "x-nulldown-account-id";

export type DropBranchMode = "owner" | "clone";
export type DropBranchStatus = "active" | "promoted" | "archived";

/*
`headSnapshotId` points at the latest materialized branch state. Event sequencing is
tracked separately so the branch can rebuild content from checkpoints plus diff ranges.
*/
export interface DropBranchRecord {
  version: 1;
  branchId: string;
  rootDropId: string;
  baseDropId: string;
  mode: DropBranchMode;
  status: DropBranchStatus;
  ownerAccountId: string | null;
  writerAccountId: string | null;
  writerClientId: string | null;
  headSnapshotId: number;
  snapshotHeapVersion?: number;
  headEventSeq?: number | null;
  checkpointInterval?: number;
  createdAt: number;
  updatedAt: number;
}

export interface DropSnapshotRecord {
  version: 1;
  snapshotId: number;
  rootDropId: string;
  branchId: string;
  parentSnapshotId: number | null;
  seq: number;
  eventIds: string[];
  checkpointed: boolean;
  patchStartSeq?: number | null;
  patchEndSeq?: number | null;
  checkpointKey?: string;
  textLength: number;
  createdAt: number;
}

export interface DropBranchResolveResponse {
  rootDropId: string;
  branchId: string;
  mode: DropBranchMode;
  created: boolean;
  headSnapshotId: number;
  ownerAccountId: string | null;
  writerAccountId: string | null;
}

export interface DropBranchContentResponse {
  rootDropId: string;
  branchId: string;
  snapshotId: number;
  content: string;
}

export interface DropSnapshotListResponse {
  rootDropId: string;
  branchId: string;
  snapshots: DropSnapshotRecord[];
}

export interface DropBranchPromoteResponse {
  dropId: string;
  url: string;
  rootDropId: string;
  branchId: string;
  snapshotId: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isString = (value: unknown): value is string => typeof value === "string";

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

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

import type { DropBranchRecord, DropSnapshotRecord } from "../branch";

const DROP_BRANCH_RECORD_VERSION_V1 = 1 as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isString = (value: unknown): value is string => typeof value === "string";

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export const isDropBranchRecordV1 = (
  value: unknown,
): value is DropBranchRecord => {
  if (!isRecord(value)) return false;
  if (value.version !== DROP_BRANCH_RECORD_VERSION_V1) return false;
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

export const isDropSnapshotRecordV1 = (
  value: unknown,
): value is DropSnapshotRecord => {
  if (!isRecord(value)) return false;
  if (value.version !== DROP_BRANCH_RECORD_VERSION_V1) return false;
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

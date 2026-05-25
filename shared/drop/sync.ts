import type { DropVisibility } from "./types";
import type { DropEnvelopeV1 } from "./types";

export type DropSyncOpKind = "publish";

export type DropSyncConflictReason =
  | "remote_state_mismatch"
  | "remote_id_conflict";

export type DropSyncConflictStatus = "pending" | "resolved";

export type DropSyncConflictResolution = "accept-local" | "accept-remote";

export interface DropSyncConflictSnapshot {
  id: string;
  envelope: DropEnvelopeV1;
  createdAt: number;
  updatedAt: number;
  revision?: string | null;
}

export interface DropSyncConflictRecord {
  version: 1;
  id: string;
  dropId: string;
  opKind: DropSyncOpKind;
  reason: DropSyncConflictReason;
  code?: string | null;
  status: DropSyncConflictStatus;
  local: DropSyncConflictSnapshot;
  remote: DropSyncConflictSnapshot | null;
  createdAt: number;
  resolvedAt?: number;
  resolution?: DropSyncConflictResolution;
}

export type DropSyncPublishSource =
  | "mode_transition"
  | "create_online"
  | "manual_sync";

export interface DropSyncQueueEntry {
  version: 1;
  dropId: string;
  visibility: DropVisibility;
  source: DropSyncPublishSource;
  queuedAt: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isSnapshot = (value: unknown): value is DropSyncConflictSnapshot => {
  if (!isRecord(value)) {
    return false;
  }

  if (
    value.revision !== undefined &&
    value.revision !== null &&
    typeof value.revision !== "string"
  ) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    typeof value.updatedAt === "number" &&
    Number.isFinite(value.updatedAt) &&
    isRecord(value.envelope)
  );
};

export const isDropSyncConflictRecord = (
  value: unknown,
): value is DropSyncConflictRecord => {
  if (!isRecord(value)) {
    return false;
  }

  if (value.version !== 1) {
    return false;
  }

  if (value.opKind !== "publish") {
    return false;
  }

  if (
    value.reason !== "remote_state_mismatch" &&
    value.reason !== "remote_id_conflict"
  ) {
    return false;
  }

  if (value.status !== "pending" && value.status !== "resolved") {
    return false;
  }

  if (
    value.code !== undefined &&
    value.code !== null &&
    typeof value.code !== "string"
  ) {
    return false;
  }

  if (!isSnapshot(value.local)) {
    return false;
  }

  if (value.remote !== null && !isSnapshot(value.remote)) {
    return false;
  }

  if (typeof value.id !== "string" || typeof value.dropId !== "string") {
    return false;
  }

  if (
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt)
  ) {
    return false;
  }

  if (value.resolvedAt !== undefined) {
    if (
      typeof value.resolvedAt !== "number" ||
      !Number.isFinite(value.resolvedAt)
    ) {
      return false;
    }
  }

  if (
    value.resolution !== undefined &&
    value.resolution !== "accept-local" &&
    value.resolution !== "accept-remote"
  ) {
    return false;
  }

  return true;
};

export const isDropSyncConflictRecordList = (
  value: unknown,
): value is DropSyncConflictRecord[] =>
  Array.isArray(value) &&
  value.every((entry) => isDropSyncConflictRecord(entry));

const isDropVisibility = (value: unknown): value is DropVisibility =>
  value === "private" || value === "unlisted" || value === "public";

export const isDropSyncPublishSource = (
  value: unknown,
): value is DropSyncPublishSource =>
  value === "mode_transition" ||
  value === "create_online" ||
  value === "manual_sync";

export const isDropSyncQueueEntry = (
  value: unknown,
): value is DropSyncQueueEntry => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.version === 1 &&
    typeof value.dropId === "string" &&
    isDropVisibility(value.visibility) &&
    isDropSyncPublishSource(value.source) &&
    typeof value.queuedAt === "number" &&
    Number.isFinite(value.queuedAt)
  );
};

export const isDropSyncQueueEntryList = (
  value: unknown,
): value is DropSyncQueueEntry[] =>
  Array.isArray(value) && value.every((entry) => isDropSyncQueueEntry(entry));

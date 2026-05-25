import type { JsonValue } from "./diff";

export const DROP_DIFF_EVENT_METADATA_KEY_PREFIX = "__drop_diff_event_metadata__/";
export const DROP_SNAPSHOT_METADATA_KEY_PREFIX = "__drop_snapshot_metadata__/";
export const DROP_RESOLVED_HEAP_KEY_PREFIX = "__drop_resolved_heap__/";

const SIDECAR_SEQ_PAD = 16;

export type DropSidecarAnnotationKind =
  | "summary"
  | "semantic-tag"
  | "ranking"
  | "plugin-reference"
  | "agent-note"
  | "policy-decision"
  | "ui-response";

export interface DropSidecarAnnotation {
  kind: DropSidecarAnnotationKind;
  value: JsonValue;
  confidence?: number;
  source?: string;
}

export interface DropDiffEventMetadataSidecar {
  version: 1;
  rootDropId: string;
  branchId: string;
  seq: number;
  eventId: string;
  updatedAt: number;
  updatedBy: string;
  annotations: DropSidecarAnnotation[];
}

export interface DropSnapshotMetadataSidecar {
  version: 1;
  snapshotterId: string;
  rootDropId: string;
  branchId: string;
  snapshotId: number;
  createdAt: number;
  updatedAt: number;
  summary?: string;
  tags?: string[];
  embeddingRef?: string;
  pluginRefs?: string[];
  memoryRefs?: string[];
  resolvedHeapRefs?: string[];
}

export interface DropSidecarJsonObject {
  json(): Promise<unknown>;
}

export interface DropSidecarJsonStore {
  get(key: string): Promise<DropSidecarJsonObject | null>;
  put(
    key: string,
    value: string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  isNumber(value) && Number.isInteger(value) && value >= 0;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

const isJsonValue = (value: unknown, depth = 0): value is JsonValue => {
  if (depth > 24) return false;
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry, depth + 1));
  }
  if (isRecord(value)) {
    return Object.values(value).every((entry) => isJsonValue(entry, depth + 1));
  }
  return false;
};

const isDropSidecarAnnotationKind = (
  value: unknown,
): value is DropSidecarAnnotationKind =>
  value === "summary" ||
  value === "semantic-tag" ||
  value === "ranking" ||
  value === "plugin-reference" ||
  value === "agent-note" ||
  value === "policy-decision" ||
  value === "ui-response";

export const sanitizeSidecarKeyPart = (value: string): string =>
  value.replace(/[^A-Za-z0-9._:-]/g, "_");

export const formatSidecarSeq = (seq: number): string =>
  String(seq).padStart(SIDECAR_SEQ_PAD, "0");

export const dropDiffEventMetadataSidecarPrefix = (
  rootDropId: string,
  branchId: string,
): string => `${DROP_DIFF_EVENT_METADATA_KEY_PREFIX}${rootDropId}/${branchId}/`;

export const dropDiffEventMetadataSidecarKey = (
  rootDropId: string,
  branchId: string,
  seq: number,
): string =>
  `${dropDiffEventMetadataSidecarPrefix(rootDropId, branchId)}${formatSidecarSeq(seq)}.json`;

export const dropSnapshotMetadataSidecarPrefix = (
  rootDropId: string,
  branchId: string,
  snapshotterId?: string,
): string =>
  `${DROP_SNAPSHOT_METADATA_KEY_PREFIX}${rootDropId}/${branchId}/${
    snapshotterId ? `${sanitizeSidecarKeyPart(snapshotterId)}/` : ""
  }`;

export const dropSnapshotMetadataSidecarKey = (
  rootDropId: string,
  branchId: string,
  snapshotterId: string,
  snapshotId: number,
): string =>
  `${dropSnapshotMetadataSidecarPrefix(
    rootDropId,
    branchId,
    snapshotterId,
  )}${snapshotId}.json`;

export const dropResolvedHeapPrefix = (
  rootDropId: string,
  branchId: string,
  resolverId?: string,
): string =>
  `${DROP_RESOLVED_HEAP_KEY_PREFIX}${rootDropId}/${branchId}/${
    resolverId ? `${sanitizeSidecarKeyPart(resolverId)}/` : ""
  }`;

export const dropResolvedHeapKey = (
  rootDropId: string,
  branchId: string,
  resolverId: string,
  snapshotId: number,
): string =>
  `${dropResolvedHeapPrefix(rootDropId, branchId, resolverId)}${snapshotId}.json`;

export const isDropSidecarAnnotation = (
  value: unknown,
): value is DropSidecarAnnotation => {
  if (!isRecord(value)) return false;
  if (!isDropSidecarAnnotationKind(value.kind)) return false;
  if (!isJsonValue(value.value)) return false;
  if (value.confidence !== undefined) {
    if (!isNumber(value.confidence)) return false;
    if (value.confidence < 0 || value.confidence > 1) return false;
  }
  if (value.source !== undefined && !isString(value.source)) return false;
  return true;
};

export const isDropDiffEventMetadataSidecar = (
  value: unknown,
): value is DropDiffEventMetadataSidecar => {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (!isString(value.rootDropId)) return false;
  if (!isString(value.branchId)) return false;
  if (!isNonNegativeInteger(value.seq)) return false;
  if (!isString(value.eventId)) return false;
  if (!isNonNegativeInteger(value.updatedAt)) return false;
  if (!isString(value.updatedBy)) return false;
  return (
    Array.isArray(value.annotations) &&
    value.annotations.every(isDropSidecarAnnotation)
  );
};

export const isDropSnapshotMetadataSidecar = (
  value: unknown,
): value is DropSnapshotMetadataSidecar => {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (!isString(value.snapshotterId)) return false;
  if (!isString(value.rootDropId)) return false;
  if (!isString(value.branchId)) return false;
  if (!isNonNegativeInteger(value.snapshotId)) return false;
  if (!isNonNegativeInteger(value.createdAt)) return false;
  if (!isNonNegativeInteger(value.updatedAt)) return false;
  if (value.summary !== undefined && !isString(value.summary)) return false;
  if (value.tags !== undefined && !isStringArray(value.tags)) return false;
  if (value.embeddingRef !== undefined && !isString(value.embeddingRef)) {
    return false;
  }
  if (value.pluginRefs !== undefined && !isStringArray(value.pluginRefs)) {
    return false;
  }
  if (value.memoryRefs !== undefined && !isStringArray(value.memoryRefs)) {
    return false;
  }
  if (
    value.resolvedHeapRefs !== undefined &&
    !isStringArray(value.resolvedHeapRefs)
  ) {
    return false;
  }
  return true;
};

export const readDropSidecar = async <T>(
  store: DropSidecarJsonStore,
  key: string,
  guard: (value: unknown) => value is T,
): Promise<T | null> => {
  const object = await store.get(key);
  if (!object) return null;

  try {
    const parsed = await object.json();
    return guard(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const writeDropSidecar = async (
  store: DropSidecarJsonStore,
  key: string,
  value: unknown,
): Promise<void> => {
  await store.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" },
  });
};

export const readDropDiffEventMetadataSidecar = (
  store: DropSidecarJsonStore,
  rootDropId: string,
  branchId: string,
  seq: number,
): Promise<DropDiffEventMetadataSidecar | null> =>
  readDropSidecar(
    store,
    dropDiffEventMetadataSidecarKey(rootDropId, branchId, seq),
    isDropDiffEventMetadataSidecar,
  );

export const writeDropDiffEventMetadataSidecar = (
  store: DropSidecarJsonStore,
  sidecar: DropDiffEventMetadataSidecar,
): Promise<void> =>
  writeDropSidecar(
    store,
    dropDiffEventMetadataSidecarKey(
      sidecar.rootDropId,
      sidecar.branchId,
      sidecar.seq,
    ),
    sidecar,
  );

export const readDropSnapshotMetadataSidecar = (
  store: DropSidecarJsonStore,
  rootDropId: string,
  branchId: string,
  snapshotterId: string,
  snapshotId: number,
): Promise<DropSnapshotMetadataSidecar | null> =>
  readDropSidecar(
    store,
    dropSnapshotMetadataSidecarKey(
      rootDropId,
      branchId,
      snapshotterId,
      snapshotId,
    ),
    isDropSnapshotMetadataSidecar,
  );

export const writeDropSnapshotMetadataSidecar = (
  store: DropSidecarJsonStore,
  sidecar: DropSnapshotMetadataSidecar,
): Promise<void> =>
  writeDropSidecar(
    store,
    dropSnapshotMetadataSidecarKey(
      sidecar.rootDropId,
      sidecar.branchId,
      sidecar.snapshotterId,
      sidecar.snapshotId,
    ),
    sidecar,
  );

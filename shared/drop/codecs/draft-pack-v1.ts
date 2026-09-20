import type {
  DropDraftDiffOp,
  DropDraftPack,
  DropDraftSnapshot,
  DropPayload,
} from "../types";

const DROP_DRAFT_PACK_VERSION_V1 = 1 as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isString = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isDropDraftDiffOp = (value: unknown): value is DropDraftDiffOp => {
  if (!isRecord(value)) return false;

  if (value.type !== "insert" && value.type !== "delete") {
    return false;
  }

  return isNumber(value.start) && isNumber(value.end) && isString(value.text);
};

const isDropDraftSnapshot = (value: unknown): value is DropDraftSnapshot => {
  if (!isRecord(value)) return false;

  if (
    !isNumber(value.snapshotId) ||
    !isNumber(value.createdAt) ||
    !isNumber(value.fromLength) ||
    !isNumber(value.toLength)
  ) {
    return false;
  }

  return (
    Array.isArray(value.ops) &&
    value.ops.every((operation) => isDropDraftDiffOp(operation))
  );
};

type DropDraftPackV1 = DropDraftPack & { version: 1 };

const isDropDraftPackWire = (value: unknown): value is DropDraftPackV1 => {
  if (!isRecord(value)) return false;

  if (value.version !== DROP_DRAFT_PACK_VERSION_V1) return false;

  if (value.policy !== "edited-only" && value.policy !== "always") {
    return false;
  }

  if (value.source !== "new-drop" && value.source !== "edited-drop") {
    return false;
  }

  if (!isNumber(value.createdAt)) return false;

  if (
    value.currentSnapshotId !== undefined &&
    !isNumber(value.currentSnapshotId)
  ) {
    return false;
  }

  if (value.truncated !== undefined && typeof value.truncated !== "boolean") {
    return false;
  }

  return (
    Array.isArray(value.snapshots) &&
    value.snapshots.every((snapshot) => isDropDraftSnapshot(snapshot))
  );
};

/** Decodes a persisted V1 draft pack to the canonical draft-pack model. */
export const decodeDropDraftPack = (value: unknown): DropDraftPack | null => {
  if (!isDropDraftPackWire(value)) return null;
  const pack: Partial<DropDraftPackV1> = { ...value };
  delete pack.version;
  return pack as unknown as DropDraftPack;
};

/** Encodes a canonical draft pack in its persisted V1 representation. */
export const encodeDropDraftPack = (
  pack: DropDraftPack,
): DropDraftPackV1 => ({ version: DROP_DRAFT_PACK_VERSION_V1, ...pack });

/** Returns true when `value` is a persisted V1 draft pack. */
export const isDropDraftPack = (value: unknown): value is DropDraftPack =>
  decodeDropDraftPack(value) !== null;

/** Decodes a persisted V1 plaintext payload without rewriting its metadata. */
export const decodeDropPayload = (value: unknown): DropPayload | null => {
  if (!isRecord(value) || !isString(value.content)) return null;
  if (value.metadata !== undefined && !isRecord(value.metadata)) return null;
  if (value.draftPack !== undefined && !isDropDraftPackWire(value.draftPack)) {
    return null;
  }

  const { draftPack, ...payload } = value;
  return {
    ...payload,
    ...(draftPack === undefined
      ? {}
      : { draftPack: decodeDropDraftPack(draftPack)! }),
  } as DropPayload;
};

/** Encodes a canonical plaintext payload in its persisted V1 representation. */
export const encodeDropPayload = (payload: DropPayload): Record<string, unknown> => ({
  ...payload,
  ...(payload.draftPack === undefined
    ? {}
    : { draftPack: encodeDropDraftPack(payload.draftPack) }),
});

/** Returns true when `value` is a persisted V1 plaintext payload. */
export const isDropPayload = (value: unknown): value is DropPayload =>
  decodeDropPayload(value) !== null;

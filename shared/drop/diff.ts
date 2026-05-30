/*
This module is the wire format bridge between the editor's binary diff ops and the
JSON-safe payloads sent through branch and diff APIs. It preserves the older
string-based op shape while carrying the native encoded diff alongside it.
*/

import { DiffOp, type Diff, type DiffRange } from "../nulledit/types";
import { decodeText, encodeText } from "../nulledit/textDiff";

export type DropDiffOpType = "insert" | "delete";
export type DropDiffEventKind =
  | "user.edit"
  | "agent.edit"
  | "nullplug.invoke"
  | "nullplug.result"
  | "ui.response"
  | "policy.decision";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface DropDiffNativeOp {
  op: DiffOp;
  data: string;
  range?: DiffRange;
}

export interface DropDiffOp {
  type?: DropDiffOpType;
  start?: number;
  end?: number;
  text?: string;
  native?: DropDiffNativeOp;
}

export interface DropDiffEventMetadata {
  kind?: DropDiffEventKind;
  intent?: string;
  pluginId?: string;
  args?: Record<string, JsonValue>;
  batchId?: string;
  batchIndex?: number;
  parentEventId?: string;
  followsSeq?: number;
  labels?: string[];
  confidence?: number;
  resultRef?: string;
  policyDecisionRef?: string;
}

export interface DropDiffEvent {
  eventId: string;
  seq: number;
  dropId: string;
  sourceClientId: string;
  createdAt: number;
  snapshotId?: number;
  ops: DropDiffOp[];
  metadata?: DropDiffEventMetadata;
}

/** Renderable stable reference to a branch diff event. */
export type DropDiffRenderableRef = `<diff:${string}>`;

/** Stable reference to one immutable branch diff event. */
export interface DropDiffRef {
  /** Root drop id that owns the branch timeline. */
  rootDropId: string;
  /** Branch id that stores the diff event. */
  branchId: string;
  /** Durable event sequence within the branch. */
  seq: number;
  /** Event id supplied by the writer. */
  eventId: string;
  /** Markdown/renderable event ref form for docs and semantic heaps. */
  ref: DropDiffRenderableRef;
  /** Snapshot id that accepted the event, when known. */
  snapshotId?: number;
}

export interface DropDiffEnvelope {
  version: 1;
  events: DropDiffEvent[];
}

export interface DropDiffPollResponse {
  events: DropDiffEvent[];
  cursor: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isJsonValue = (value: unknown, depth = 0): value is JsonValue => {
  if (depth > 24) return false;
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry, depth + 1));
  }
  if (isPlainRecord(value)) {
    return Object.values(value).every((entry) => isJsonValue(entry, depth + 1));
  }
  return false;
};

const isDropDiffEventKind = (value: unknown): value is DropDiffEventKind =>
  value === "user.edit" ||
  value === "agent.edit" ||
  value === "nullplug.invoke" ||
  value === "nullplug.result" ||
  value === "ui.response" ||
  value === "policy.decision";

/** Formats an event id as a renderable diff reference. */
export const createDropDiffRenderableRef = (
  eventId: string,
): DropDiffRenderableRef => `<diff:${eventId}>`;

/** Creates a stable branch diff reference for snapshotters and semantic heaps. */
export const createDropDiffRef = (input: {
  rootDropId: string;
  branchId: string;
  seq: number;
  eventId: string;
  snapshotId?: number;
}): DropDiffRef => ({
  rootDropId: input.rootDropId,
  branchId: input.branchId,
  seq: input.seq,
  eventId: input.eventId,
  ref: createDropDiffRenderableRef(input.eventId),
  ...(input.snapshotId !== undefined ? { snapshotId: input.snapshotId } : {}),
});

/** Checks whether a value is a renderable diff reference string. */
export const isDropDiffRenderableRef = (
  value: unknown,
): value is DropDiffRenderableRef =>
  typeof value === "string" && /^<diff:[^>]+>$/.test(value);

/** Checks a serialized stable branch diff reference. */
export const isDropDiffRef = (value: unknown): value is DropDiffRef => {
  if (!isRecord(value)) return false;
  return (
    isString(value.rootDropId) &&
    isString(value.branchId) &&
    isNumber(value.seq) &&
    Number.isInteger(value.seq) &&
    value.seq >= 0 &&
    isString(value.eventId) &&
    isDropDiffRenderableRef(value.ref) &&
    value.ref === createDropDiffRenderableRef(value.eventId) &&
    (value.snapshotId === undefined || isNumber(value.snapshotId))
  );
};

const dropDiffMetadataKeys = new Set([
  "kind",
  "intent",
  "pluginId",
  "args",
  "batchId",
  "batchIndex",
  "parentEventId",
  "followsSeq",
  "labels",
  "confidence",
  "resultRef",
  "policyDecisionRef",
]);

export const isDropDiffEventMetadata = (
  value: unknown,
): value is DropDiffEventMetadata => {
  if (!isPlainRecord(value)) return false;
  if (!Object.keys(value).every((key) => dropDiffMetadataKeys.has(key))) {
    return false;
  }

  if (value.kind !== undefined && !isDropDiffEventKind(value.kind))
    return false;
  if (value.intent !== undefined && !isString(value.intent)) return false;
  if (value.pluginId !== undefined && !isString(value.pluginId)) return false;
  if (value.args !== undefined) {
    if (!isPlainRecord(value.args)) return false;
    if (!Object.values(value.args).every((entry) => isJsonValue(entry)))
      return false;
  }
  if (value.batchId !== undefined && !isString(value.batchId)) return false;
  if (value.batchIndex !== undefined) {
    if (!isNumber(value.batchIndex)) return false;
    if (!Number.isInteger(value.batchIndex) || value.batchIndex < 0)
      return false;
  }
  if (value.parentEventId !== undefined && !isString(value.parentEventId)) {
    return false;
  }
  if (value.followsSeq !== undefined) {
    if (!isNumber(value.followsSeq)) return false;
    if (!Number.isInteger(value.followsSeq) || value.followsSeq < -1)
      return false;
  }
  if (value.labels !== undefined) {
    if (!Array.isArray(value.labels)) return false;
    if (!value.labels.every((entry) => isString(entry))) return false;
  }
  if (value.confidence !== undefined) {
    if (!isNumber(value.confidence)) return false;
    if (value.confidence < 0 || value.confidence > 1) return false;
  }
  if (value.resultRef !== undefined && !isString(value.resultRef)) return false;
  if (
    value.policyDecisionRef !== undefined &&
    !isString(value.policyDecisionRef)
  ) {
    return false;
  }

  return true;
};

const toBase64 = (value: ArrayBuffer): string => {
  const bytes = new Uint8Array(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
};

const fromBase64 = (value: string): ArrayBuffer => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
};

const isDiffRange = (value: unknown): value is DiffRange => {
  if (!isRecord(value)) return false;
  return isNumber(value.start) && isNumber(value.end);
};

const isDiffOp = (value: unknown): value is DiffOp =>
  value === DiffOp.INSERT || value === DiffOp.DELETE || value === DiffOp.RETAIN;

export const isDropDiffOp = (value: unknown): value is DropDiffOp => {
  if (!isRecord(value)) return false;

  const hasLegacy =
    (value.type === "insert" || value.type === "delete") &&
    isNumber(value.start) &&
    isNumber(value.end) &&
    isString(value.text);

  const native = value.native;
  const hasNative =
    isRecord(native) &&
    isDiffOp(native.op) &&
    isString(native.data) &&
    (native.range === undefined || isDiffRange(native.range));

  return hasLegacy || hasNative;
};

export const isDropDiffEvent = (value: unknown): value is DropDiffEvent => {
  if (!isRecord(value)) return false;
  if (!isString(value.eventId)) return false;
  if (!isNumber(value.seq)) return false;
  if (!isString(value.dropId)) return false;
  if (!isString(value.sourceClientId)) return false;
  if (!isNumber(value.createdAt)) return false;
  if (value.snapshotId !== undefined && !isNumber(value.snapshotId))
    return false;
  if (
    value.metadata !== undefined &&
    !isDropDiffEventMetadata(value.metadata)
  ) {
    return false;
  }
  if (!Array.isArray(value.ops)) return false;
  return value.ops.every((op) => isDropDiffOp(op));
};

export const isDropDiffEnvelope = (
  value: unknown,
): value is DropDiffEnvelope => {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (!Array.isArray(value.events)) return false;
  return value.events.every((event) => isDropDiffEvent(event));
};

export const diffToDropDiffOp = (diff: Diff): DropDiffOp => {
  const range = diff.range ?? { start: 0, end: 0 };
  const text = decodeText(diff.data);

  // Keep the legacy text form populated so older readers and debugging tools stay useful.
  return {
    type: diff.op === DiffOp.DELETE ? "delete" : "insert",
    start: range.start,
    end: range.end,
    text,
    native: {
      op: diff.op,
      data: toBase64(diff.data),
      range,
    },
  };
};

export const dropDiffOpToDiff = (op: DropDiffOp): Diff | null => {
  if (op.native) {
    // Native ops are authoritative because they preserve the editor's original byte payload.
    const range = op.native.range ?? { start: 0, end: 0 };
    return {
      op: op.native.op,
      data: fromBase64(op.native.data),
      range,
    };
  }

  if (
    (op.type === "insert" || op.type === "delete") &&
    typeof op.start === "number" &&
    typeof op.end === "number" &&
    typeof op.text === "string"
  ) {
    return {
      op: op.type === "insert" ? DiffOp.INSERT : DiffOp.DELETE,
      data: encodeText(op.text),
      range: {
        start: op.start,
        end: op.end,
      },
    };
  }

  return null;
};

/*
This module is the wire format bridge between the editor's binary diff ops and the
JSON-safe payloads sent through branch and diff APIs. It preserves the older
string-based op shape while carrying the native encoded diff alongside it.
*/

import { DiffOp, type Diff, type DiffRange } from "../nulledit/types";
import { decodeText, encodeText } from "../nulledit/textDiff";
import {
  DropDiffEnvelopeSchema,
  DropDiffEventMetadataSchema,
  DropDiffEventSchema,
  DropDiffOpSchema,
} from "./diffSchemas";

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

const isString = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

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

export const isDropDiffEventMetadata = (
  value: unknown,
): value is DropDiffEventMetadata =>
  DropDiffEventMetadataSchema.safeParse(value).success;

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

export const isDropDiffOp = (value: unknown): value is DropDiffOp =>
  DropDiffOpSchema.safeParse(value).success;

export const isDropDiffEvent = (value: unknown): value is DropDiffEvent =>
  DropDiffEventSchema.safeParse(value).success;

export const isDropDiffEnvelope = (
  value: unknown,
): value is DropDiffEnvelope => DropDiffEnvelopeSchema.safeParse(value).success;

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

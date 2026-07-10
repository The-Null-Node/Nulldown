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

/** Legacy JSON-safe operation kind carried alongside native diff ops. */
export type DropDiffOpType = "insert" | "delete";
/** Semantic category for diff event metadata. */
export type DropDiffEventKind =
  | "user.edit"
  | "agent.edit"
  | "nullplug.invoke"
  | "nullplug.result"
  | "ui.response"
  | "policy.decision";

/** JSON primitive allowed in diff event metadata. */
export type JsonPrimitive = string | number | boolean | null;
/** JSON value allowed in diff event metadata. */
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Native editor diff op encoded for JSON transport. */
export interface DropDiffNativeOp {
  /** Nulledit operation code. */
  op: DiffOp;
  /** Base64-encoded binary `Diff.data` payload. */
  data: string;
  /** Text range the operation applies to. */
  range?: DiffRange;
}

/** JSON-safe branch diff operation with legacy and native representations. */
export interface DropDiffOp {
  /** Legacy text operation type. */
  type?: DropDiffOpType;
  /** Legacy inclusive start offset. */
  start?: number;
  /** Legacy exclusive end offset. */
  end?: number;
  /** Legacy text payload. */
  text?: string;
  /** Authoritative native binary-safe operation. */
  native?: DropDiffNativeOp;
}

/** Structured metadata attached to a branch diff event. */
export interface DropDiffEventMetadata {
  /** High-level event kind for retrieval and policy routing. */
  kind?: DropDiffEventKind;
  /** Human-readable intent for agent/user authored events. */
  intent?: string;
  /** Nullplug id when the event came from plugin execution. */
  pluginId?: string;
  /** Additional semantic metadata; rich fields belong here, not top level. */
  args?: Record<string, JsonValue>;
  /** Batch id for grouped diff events. */
  batchId?: string;
  /** Position within a batch. */
  batchIndex?: number;
  /** Parent event id for response/result chains. */
  parentEventId?: string;
  /** Expected predecessor sequence for optimistic ordering. */
  followsSeq?: number;
  /** Retrieval labels. */
  labels?: string[];
  /** Agent confidence in the event or result. */
  confidence?: number;
  /** Reference to a produced result artifact. */
  resultRef?: string;
  /** Reference to a policy decision artifact. */
  policyDecisionRef?: string;
}

/** Immutable edit event accepted into a branch timeline. */
export interface DropDiffEvent {
  /** Writer-supplied stable event id used for dedupe. */
  eventId: string;
  /** Durable branch sequence assigned by the server. */
  seq: number;
  /** Root/drop id targeted by the diff transport. */
  dropId: string;
  /** Client id that produced the event. */
  sourceClientId: string;
  /** Creation time in epoch milliseconds. */
  createdAt: number;
  /** Snapshot id that accepted the event, when known. */
  snapshotId?: number;
  /** Ordered operations in this event. */
  ops: DropDiffOp[];
  /** Optional semantic metadata. */
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
  /** Envelope schema version. */
  version: 1;
  /** Events carried by the transport envelope. */
  events: DropDiffEvent[];
}

/** Poll response for branch diff transport. */
export interface DropDiffPollResponse {
  /** Events after the requested cursor. */
  events: DropDiffEvent[];
  /** Cursor to send on the next poll, or null when no events are available. */
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

/** Returns true when `value` is valid diff event metadata. */
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

/** Returns true when `value` is a valid JSON-safe branch diff operation. */
export const isDropDiffOp = (value: unknown): value is DropDiffOp =>
  DropDiffOpSchema.safeParse(value).success;

/** Returns true when `value` is a valid branch diff event. */
export const isDropDiffEvent = (value: unknown): value is DropDiffEvent =>
  DropDiffEventSchema.safeParse(value).success;

/** Returns true when `value` is a valid diff transport envelope. */
export const isDropDiffEnvelope = (
  value: unknown,
): value is DropDiffEnvelope => DropDiffEnvelopeSchema.safeParse(value).success;

/** Converts an in-memory Nulledit diff to the branch transport operation shape. */
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

/** Converts a branch transport operation back to an in-memory Nulledit diff. */
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

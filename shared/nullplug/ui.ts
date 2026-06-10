import type { DropDiffEnvelope } from "../drop/diff";
import type { JsonValue, NullplugYield } from "./types";
import {
  NullplugUiPrimitiveSchema,
  NullplugUiResponseFactSchema,
  NullplugUiSourceSchema,
  NullplugUiStatePatchFactSchema,
  NullplugUiStatePatchOperationSchema,
  NullplugUiStateSnapshotSchema,
} from "./uiSchemas";

export const NULLPLUG_UI_RESPONSE_FACT_KEY_PREFIX =
  "__nullplug_ui_response_fact__/";
export const NULLPLUG_UI_STATE_PATCH_FACT_KEY_PREFIX =
  "__nullplug_ui_state_patch_fact__/";
export const NULLPLUG_UI_STATE_SNAPSHOT_KEY_PREFIX =
  "__nullplug_ui_state_snapshot__/";

export interface NullplugUiSource {
  rootDropId: string;
  branchId?: string;
  snapshotId?: number;
  eventId?: string;
  callId?: string;
}

export type NullplugUiFieldType =
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "select";

export interface NullplugUiFieldOption {
  label: string;
  value: JsonValue;
}

export interface NullplugUiField {
  name: string;
  type: NullplugUiFieldType;
  label?: string;
  required?: boolean;
  defaultValue?: JsonValue;
  options?: NullplugUiFieldOption[];
  metadata?: Record<string, JsonValue>;
}

export interface NullplugFormPrimitive {
  kind: "form";
  id: string;
  title?: string;
  description?: string;
  fields: NullplugUiField[];
  submitLabel?: string;
  source?: NullplugUiSource;
  metadata?: Record<string, JsonValue>;
}

export interface NullplugActionPrimitive {
  kind: "action";
  id: string;
  label: string;
  intent?: string;
  value?: JsonValue;
  requiresConfirmation?: boolean;
  source?: NullplugUiSource;
  metadata?: Record<string, JsonValue>;
}

export interface NullplugCardPrimitive {
  kind: "card";
  id: string;
  title?: string;
  body?: string;
  actions?: NullplugActionPrimitive[];
  source?: NullplugUiSource;
  metadata?: Record<string, JsonValue>;
}

export type NullplugUiPrimitive =
  | NullplugFormPrimitive
  | NullplugActionPrimitive
  | NullplugCardPrimitive;

export interface NullplugUiResponseFact {
  version: 1;
  kind: "ui.response";
  id: string;
  primitiveId: string;
  createdAt: number;
  source: NullplugUiSource;
  data: Record<string, JsonValue>;
  proposedDiffs?: DropDiffEnvelope;
  metadata?: Record<string, JsonValue>;
}

export interface NullplugUiStatePatchOperation {
  op: "set" | "delete";
  path: string[];
  value?: JsonValue;
}

export interface NullplugUiStatePatchFact {
  version: 1;
  kind: "ui.state.patch";
  id: string;
  callId: string;
  createdAt: number;
  source: NullplugUiSource;
  patch: NullplugUiStatePatchOperation[];
  reason?: string;
  metadata?: Record<string, JsonValue>;
}

export interface NullplugUiStateSnapshot {
  version: 1;
  kind: "ui.state.snapshot";
  id: string;
  callId: string;
  createdAt: number;
  source: NullplugUiSource;
  state: Record<string, JsonValue>;
  patchIds?: string[];
  metadata?: Record<string, JsonValue>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const sanitizeNullplugUiKeyPart = (value: string): string =>
  value.replace(/[^A-Za-z0-9._:-]/g, "_");

export const nullplugUiResponseFactPrefix = (
  rootDropId: string,
  branchId?: string,
): string =>
  `${NULLPLUG_UI_RESPONSE_FACT_KEY_PREFIX}${sanitizeNullplugUiKeyPart(
    rootDropId,
  )}/${branchId ? sanitizeNullplugUiKeyPart(branchId) : "drop"}/`;

export const nullplugUiResponseFactKey = (
  fact: Pick<NullplugUiResponseFact, "id" | "primitiveId" | "source">,
): string =>
  `${nullplugUiResponseFactPrefix(
    fact.source.rootDropId,
    fact.source.branchId,
  )}${sanitizeNullplugUiKeyPart(fact.primitiveId)}/${sanitizeNullplugUiKeyPart(
    fact.id,
  )}.json`;

export const nullplugUiStatePatchFactPrefix = (
  rootDropId: string,
  branchId?: string,
  callId?: string,
): string =>
  `${NULLPLUG_UI_STATE_PATCH_FACT_KEY_PREFIX}${sanitizeNullplugUiKeyPart(
    rootDropId,
  )}/${branchId ? sanitizeNullplugUiKeyPart(branchId) : "drop"}/${
    callId ? `${sanitizeNullplugUiKeyPart(callId)}/` : ""
  }`;

export const nullplugUiStatePatchFactKey = (
  fact: Pick<NullplugUiStatePatchFact, "id" | "callId" | "source">,
): string =>
  `${nullplugUiStatePatchFactPrefix(
    fact.source.rootDropId,
    fact.source.branchId,
    fact.callId,
  )}${sanitizeNullplugUiKeyPart(fact.id)}.json`;

export const nullplugUiStateSnapshotPrefix = (
  rootDropId: string,
  branchId?: string,
  callId?: string,
): string =>
  `${NULLPLUG_UI_STATE_SNAPSHOT_KEY_PREFIX}${sanitizeNullplugUiKeyPart(
    rootDropId,
  )}/${branchId ? sanitizeNullplugUiKeyPart(branchId) : "drop"}/${
    callId ? `${sanitizeNullplugUiKeyPart(callId)}/` : ""
  }`;

export const nullplugUiStateSnapshotKey = (
  snapshot: Pick<NullplugUiStateSnapshot, "id" | "callId" | "source">,
): string =>
  `${nullplugUiStateSnapshotPrefix(
    snapshot.source.rootDropId,
    snapshot.source.branchId,
    snapshot.callId,
  )}${sanitizeNullplugUiKeyPart(snapshot.id)}.json`;

export const isNullplugUiSource = (value: unknown): value is NullplugUiSource =>
  NullplugUiSourceSchema.safeParse(value).success;

export const isNullplugUiPrimitive = (
  value: unknown,
): value is NullplugUiPrimitive =>
  NullplugUiPrimitiveSchema.safeParse(value).success;

export const isNullplugUiStatePatchOperation = (
  value: unknown,
): value is NullplugUiStatePatchOperation =>
  NullplugUiStatePatchOperationSchema.safeParse(value).success;

export const isNullplugUiResponseFact = (
  value: unknown,
): value is NullplugUiResponseFact =>
  NullplugUiResponseFactSchema.safeParse(value).success;

export const isNullplugUiStatePatchFact = (
  value: unknown,
): value is NullplugUiStatePatchFact =>
  NullplugUiStatePatchFactSchema.safeParse(value).success;

export const isNullplugUiStateSnapshot = (
  value: unknown,
): value is NullplugUiStateSnapshot =>
  NullplugUiStateSnapshotSchema.safeParse(value).success;

const cloneJsonRecord = (
  value: Record<string, JsonValue>,
): Record<string, JsonValue> =>
  JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;

export const applyNullplugUiStatePatch = (
  state: Record<string, JsonValue>,
  patch: readonly NullplugUiStatePatchOperation[],
): Record<string, JsonValue> => {
  const next = cloneJsonRecord(state);

  patch.forEach((operation) => {
    let cursor: Record<string, JsonValue> = next;
    const path = operation.path;
    for (let index = 0; index < path.length - 1; index += 1) {
      const part = path[index];
      const current = cursor[part];
      if (!isRecord(current) || Array.isArray(current)) {
        cursor[part] = {};
      }
      cursor = cursor[part] as Record<string, JsonValue>;
    }

    const leaf = path[path.length - 1];
    if (operation.op === "set") {
      cursor[leaf] = operation.value as JsonValue;
    } else {
      delete cursor[leaf];
    }
  });

  return next;
};

export const nullplugUiResponseFactToYield = (
  fact: NullplugUiResponseFact,
): NullplugYield => {
  if (!isNullplugUiResponseFact(fact)) {
    throw new Error("Invalid nullplug UI response fact.");
  }

  return {
    id: fact.id,
    kind: "ui.response",
    value: fact as unknown as Record<string, JsonValue>,
    createdAt: fact.createdAt,
    metadata: fact.metadata,
  };
};

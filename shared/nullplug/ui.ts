import { isDropDiffEnvelope, type DropDiffEnvelope } from "../drop/diff";
import type { JsonValue, NullplugYield } from "./types";

export const NULLPLUG_UI_RESPONSE_FACT_KEY_PREFIX = "__nullplug_ui_response_fact__/";
export const NULLPLUG_UI_STATE_PATCH_FACT_KEY_PREFIX = "__nullplug_ui_state_patch_fact__/";
export const NULLPLUG_UI_STATE_SNAPSHOT_KEY_PREFIX = "__nullplug_ui_state_snapshot__/";

export interface NullplugUiSource {
  rootDropId: string;
  branchId?: string;
  snapshotId?: number;
  eventId?: string;
  callId?: string;
}

export type NullplugUiFieldType = "text" | "textarea" | "number" | "boolean" | "select";

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
  if (isRecord(value)) {
    return Object.values(value).every((entry) => isJsonValue(entry, depth + 1));
  }
  return false;
};

const isJsonRecord = (value: unknown): value is Record<string, JsonValue> =>
  isRecord(value) && Object.values(value).every((entry) => isJsonValue(entry));

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

export const isNullplugUiSource = (value: unknown): value is NullplugUiSource => {
  if (!isRecord(value)) return false;
  if (!isString(value.rootDropId)) return false;
  if (value.branchId !== undefined && !isString(value.branchId)) return false;
  if (value.snapshotId !== undefined && !isNumber(value.snapshotId)) return false;
  if (value.eventId !== undefined && !isString(value.eventId)) return false;
  if (value.callId !== undefined && !isString(value.callId)) return false;
  return true;
};

const isNullplugUiFieldType = (value: unknown): value is NullplugUiFieldType =>
  value === "text" ||
  value === "textarea" ||
  value === "number" ||
  value === "boolean" ||
  value === "select";

const isNullplugUiFieldOption = (
  value: unknown,
): value is NullplugUiFieldOption => {
  if (!isRecord(value)) return false;
  return isString(value.label) && isJsonValue(value.value);
};

const isNullplugUiField = (value: unknown): value is NullplugUiField => {
  if (!isRecord(value)) return false;
  if (!isString(value.name)) return false;
  if (!isNullplugUiFieldType(value.type)) return false;
  if (value.label !== undefined && !isString(value.label)) return false;
  if (value.required !== undefined && typeof value.required !== "boolean") {
    return false;
  }
  if (value.defaultValue !== undefined && !isJsonValue(value.defaultValue)) {
    return false;
  }
  if (
    value.options !== undefined &&
    (!Array.isArray(value.options) ||
      !value.options.every(isNullplugUiFieldOption))
  ) {
    return false;
  }
  if (value.metadata !== undefined && !isJsonRecord(value.metadata)) return false;
  return true;
};

const hasOptionalPrimitiveFields = (value: Record<string, unknown>): boolean => {
  if (value.source !== undefined && !isNullplugUiSource(value.source)) return false;
  if (value.metadata !== undefined && !isJsonRecord(value.metadata)) return false;
  return true;
};

const isNullplugFormPrimitive = (value: unknown): value is NullplugFormPrimitive => {
  if (!isRecord(value)) return false;
  if (value.kind !== "form" || !isString(value.id)) return false;
  if (value.title !== undefined && !isString(value.title)) return false;
  if (value.description !== undefined && !isString(value.description)) return false;
  if (!Array.isArray(value.fields) || !value.fields.every(isNullplugUiField)) {
    return false;
  }
  if (value.submitLabel !== undefined && !isString(value.submitLabel)) return false;
  return hasOptionalPrimitiveFields(value);
};

const isNullplugActionPrimitive = (
  value: unknown,
): value is NullplugActionPrimitive => {
  if (!isRecord(value)) return false;
  if (value.kind !== "action" || !isString(value.id) || !isString(value.label)) {
    return false;
  }
  if (value.intent !== undefined && !isString(value.intent)) return false;
  if (value.value !== undefined && !isJsonValue(value.value)) return false;
  if (
    value.requiresConfirmation !== undefined &&
    typeof value.requiresConfirmation !== "boolean"
  ) {
    return false;
  }
  return hasOptionalPrimitiveFields(value);
};

const isNullplugCardPrimitive = (value: unknown): value is NullplugCardPrimitive => {
  if (!isRecord(value)) return false;
  if (value.kind !== "card" || !isString(value.id)) return false;
  if (value.title !== undefined && !isString(value.title)) return false;
  if (value.body !== undefined && !isString(value.body)) return false;
  if (
    value.actions !== undefined &&
    (!Array.isArray(value.actions) ||
      !value.actions.every(isNullplugActionPrimitive))
  ) {
    return false;
  }
  return hasOptionalPrimitiveFields(value);
};

export const isNullplugUiPrimitive = (
  value: unknown,
): value is NullplugUiPrimitive =>
  isNullplugFormPrimitive(value) ||
  isNullplugActionPrimitive(value) ||
  isNullplugCardPrimitive(value);

export const isNullplugUiStatePatchOperation = (
  value: unknown,
): value is NullplugUiStatePatchOperation => {
  if (!isRecord(value)) return false;
  if (value.op !== "set" && value.op !== "delete") return false;
  if (!Array.isArray(value.path) || !value.path.every(isString)) return false;
  if (value.path.length === 0 || value.path.some((part) => !part.trim())) {
    return false;
  }
  if (value.op === "set") return isJsonValue(value.value);
  return value.value === undefined;
};

export const isNullplugUiResponseFact = (
  value: unknown,
): value is NullplugUiResponseFact => {
  if (!isRecord(value)) return false;
  if (value.version !== 1 || value.kind !== "ui.response") return false;
  if (!isString(value.id) || !isString(value.primitiveId)) return false;
  if (!isNumber(value.createdAt)) return false;
  if (!isNullplugUiSource(value.source)) return false;
  if (!isJsonRecord(value.data)) return false;
  if (value.proposedDiffs !== undefined && !isDropDiffEnvelope(value.proposedDiffs)) {
    return false;
  }
  if (value.metadata !== undefined && !isJsonRecord(value.metadata)) return false;
  return true;
};

export const isNullplugUiStatePatchFact = (
  value: unknown,
): value is NullplugUiStatePatchFact => {
  if (!isRecord(value)) return false;
  if (value.version !== 1 || value.kind !== "ui.state.patch") return false;
  if (!isString(value.id) || !isString(value.callId)) return false;
  if (!isNumber(value.createdAt)) return false;
  if (!isNullplugUiSource(value.source)) return false;
  if (
    !Array.isArray(value.patch) ||
    value.patch.length === 0 ||
    !value.patch.every(isNullplugUiStatePatchOperation)
  ) {
    return false;
  }
  if (value.reason !== undefined && !isString(value.reason)) return false;
  if (value.metadata !== undefined && !isJsonRecord(value.metadata)) return false;
  return true;
};

export const isNullplugUiStateSnapshot = (
  value: unknown,
): value is NullplugUiStateSnapshot => {
  if (!isRecord(value)) return false;
  if (value.version !== 1 || value.kind !== "ui.state.snapshot") return false;
  if (!isString(value.id) || !isString(value.callId)) return false;
  if (!isNumber(value.createdAt)) return false;
  if (!isNullplugUiSource(value.source)) return false;
  if (!isJsonRecord(value.state)) return false;
  if (
    value.patchIds !== undefined &&
    (!Array.isArray(value.patchIds) || !value.patchIds.every(isString))
  ) {
    return false;
  }
  if (value.metadata !== undefined && !isJsonRecord(value.metadata)) return false;
  return true;
};

const cloneJsonRecord = (
  value: Record<string, JsonValue>,
): Record<string, JsonValue> => JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;

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

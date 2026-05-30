import { isDropDiffEnvelope, type DropDiffEnvelope } from "../drop/diff";
import {
  isNullplugUiPrimitive,
  isNullplugUiStatePatchOperation,
  type NullplugUiPrimitive,
  type NullplugUiStatePatchOperation,
} from "./ui";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface NullplugCaller {
  dropId?: string;
  branchId?: string;
  snapshotId?: number;
  eventId?: string;
}

export interface NullplugCall {
  pluginId: string;
  version?: string;
  args: Record<string, JsonValue>;
  body?: string;
  caller: NullplugCaller;
}

export interface NullplugStreamDescriptor {
  id: string;
  kind: string;
  status?: "pending" | "running" | "complete" | "failed";
  url?: string;
  metadata?: Record<string, JsonValue>;
}

export type NullplugMutation =
  | { kind: "drop.diff.propose"; envelope: DropDiffEnvelope; reason?: string }
  | { kind: "drop.diff.apply"; envelope: DropDiffEnvelope; grantId: string }
  | { kind: "metadata.patch"; patch: JsonValue; reason?: string }
  | {
      kind: "ui.state.patch";
      callId: string;
      patch: NullplugUiStatePatchOperation[];
      reason?: string;
    }
  | { kind: "sidecar.write"; target: string; value: JsonValue };

export type NullplugYieldKind =
  | "ui.response"
  | "policy.decision"
  | "stream.event"
  | "agent.note";

export interface NullplugYield {
  id?: string;
  kind: NullplugYieldKind;
  value: JsonValue;
  createdAt?: number;
  metadata?: Record<string, JsonValue>;
}

export interface NullplugResult {
  content?: string;
  uiPrimitives?: NullplugUiPrimitive[];
  uiState?: Record<string, JsonValue>;
  metadata?: Record<string, JsonValue>;
  diffs?: DropDiffEnvelope;
  mutations?: NullplugMutation[];
  yields?: NullplugYield[];
  streams?: NullplugStreamDescriptor[];
  calls?: NullplugCall[];
}

export interface NullplugInvokeContext {
  providerId: string;
  baseUrl: string;
  callerDropId?: string;
  branchId?: string;
  snapshotId?: number;
  capabilities: string[];
  rootPolicyRef?: string;
}

export interface NullplugInvokeRequest {
  call: NullplugCall;
  context: NullplugInvokeContext;
}

export interface NullplugDiagnostic {
  level: "info" | "warn" | "error";
  message: string;
}

export interface NullplugInvokeResponse {
  result: NullplugResult;
  diagnostics?: NullplugDiagnostic[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

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

const isJsonRecord = (value: unknown): value is Record<string, JsonValue> =>
  isRecord(value) && Object.values(value).every((entry) => isJsonValue(entry));

const isNullplugCaller = (value: unknown): value is NullplugCaller => {
  if (!isRecord(value)) return false;
  if (value.dropId !== undefined && !isString(value.dropId)) return false;
  if (value.branchId !== undefined && !isString(value.branchId)) return false;
  if (value.snapshotId !== undefined && !isNumber(value.snapshotId))
    return false;
  if (value.eventId !== undefined && !isString(value.eventId)) return false;
  return true;
};

export const isNullplugCall = (value: unknown): value is NullplugCall => {
  if (!isRecord(value)) return false;
  if (!isString(value.pluginId)) return false;
  if (value.version !== undefined && !isString(value.version)) return false;
  if (!isJsonRecord(value.args)) return false;
  if (value.body !== undefined && !isString(value.body)) return false;
  return isNullplugCaller(value.caller);
};

const isNullplugStreamDescriptor = (
  value: unknown,
): value is NullplugStreamDescriptor => {
  if (!isRecord(value)) return false;
  if (!isString(value.id) || !isString(value.kind)) return false;
  if (
    value.status !== undefined &&
    value.status !== "pending" &&
    value.status !== "running" &&
    value.status !== "complete" &&
    value.status !== "failed"
  ) {
    return false;
  }
  if (value.url !== undefined && !isString(value.url)) return false;
  if (value.metadata !== undefined && !isJsonRecord(value.metadata))
    return false;
  return true;
};

const isNullplugMutation = (value: unknown): value is NullplugMutation => {
  if (!isRecord(value)) return false;
  if (value.kind === "drop.diff.propose") {
    if (!isDropDiffEnvelope(value.envelope)) return false;
    return value.reason === undefined || isString(value.reason);
  }
  if (value.kind === "drop.diff.apply") {
    if (!isDropDiffEnvelope(value.envelope)) return false;
    return isString(value.grantId);
  }
  if (value.kind === "metadata.patch") {
    if (!isJsonValue(value.patch)) return false;
    return value.reason === undefined || isString(value.reason);
  }
  if (value.kind === "ui.state.patch") {
    if (!isString(value.callId)) return false;
    if (
      !Array.isArray(value.patch) ||
      value.patch.length === 0 ||
      !value.patch.every(isNullplugUiStatePatchOperation)
    ) {
      return false;
    }
    return value.reason === undefined || isString(value.reason);
  }
  if (value.kind === "sidecar.write") {
    return isString(value.target) && isJsonValue(value.value);
  }
  return false;
};

const isNullplugYieldKind = (value: unknown): value is NullplugYieldKind =>
  value === "ui.response" ||
  value === "policy.decision" ||
  value === "stream.event" ||
  value === "agent.note";

const isNullplugYield = (value: unknown): value is NullplugYield => {
  if (!isRecord(value)) return false;
  if (value.id !== undefined && !isString(value.id)) return false;
  if (!isNullplugYieldKind(value.kind)) return false;
  if (!isJsonValue(value.value)) return false;
  if (value.createdAt !== undefined && !isNumber(value.createdAt)) return false;
  if (value.metadata !== undefined && !isJsonRecord(value.metadata))
    return false;
  return true;
};

const nullplugResultKeys = new Set([
  "content",
  "uiPrimitives",
  "uiState",
  "metadata",
  "diffs",
  "mutations",
  "yields",
  "streams",
  "calls",
]);

export const isNullplugResult = (value: unknown): value is NullplugResult => {
  if (!isRecord(value)) return false;
  if (!Object.keys(value).every((key) => nullplugResultKeys.has(key))) {
    return false;
  }
  if (value.content !== undefined && !isString(value.content)) return false;
  if (
    value.uiPrimitives !== undefined &&
    (!Array.isArray(value.uiPrimitives) ||
      !value.uiPrimitives.every(isNullplugUiPrimitive))
  ) {
    return false;
  }
  if (value.uiState !== undefined && !isJsonRecord(value.uiState)) return false;
  if (value.metadata !== undefined && !isJsonRecord(value.metadata))
    return false;
  if (value.diffs !== undefined && !isDropDiffEnvelope(value.diffs))
    return false;
  if (
    value.mutations !== undefined &&
    (!Array.isArray(value.mutations) ||
      !value.mutations.every(isNullplugMutation))
  ) {
    return false;
  }
  if (
    value.yields !== undefined &&
    (!Array.isArray(value.yields) || !value.yields.every(isNullplugYield))
  ) {
    return false;
  }
  if (
    value.streams !== undefined &&
    (!Array.isArray(value.streams) ||
      !value.streams.every(isNullplugStreamDescriptor))
  ) {
    return false;
  }
  if (
    value.calls !== undefined &&
    (!Array.isArray(value.calls) || !value.calls.every(isNullplugCall))
  ) {
    return false;
  }
  return true;
};

export const isNullplugInvokeContext = (
  value: unknown,
): value is NullplugInvokeContext => {
  if (!isRecord(value)) return false;
  if (!isString(value.providerId) || !isString(value.baseUrl)) return false;
  if (value.callerDropId !== undefined && !isString(value.callerDropId)) {
    return false;
  }
  if (value.branchId !== undefined && !isString(value.branchId)) return false;
  if (value.snapshotId !== undefined && !isNumber(value.snapshotId))
    return false;
  if (!isStringArray(value.capabilities)) return false;
  if (value.rootPolicyRef !== undefined && !isString(value.rootPolicyRef)) {
    return false;
  }
  return true;
};

export const isNullplugInvokeRequest = (
  value: unknown,
): value is NullplugInvokeRequest => {
  if (!isRecord(value)) return false;
  return isNullplugCall(value.call) && isNullplugInvokeContext(value.context);
};

export const isNullplugDiagnostic = (
  value: unknown,
): value is NullplugDiagnostic => {
  if (!isRecord(value)) return false;
  if (
    value.level !== "info" &&
    value.level !== "warn" &&
    value.level !== "error"
  ) {
    return false;
  }
  return isString(value.message);
};

export const isNullplugInvokeResponse = (
  value: unknown,
): value is NullplugInvokeResponse => {
  if (!isRecord(value)) return false;
  if (!isNullplugResult(value.result)) return false;
  if (
    value.diagnostics !== undefined &&
    (!Array.isArray(value.diagnostics) ||
      !value.diagnostics.every(isNullplugDiagnostic))
  ) {
    return false;
  }
  return true;
};

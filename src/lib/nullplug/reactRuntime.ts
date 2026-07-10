import type {
  EditorNullplugRenderState,
  EditorRenderFrame,
} from "../../stores/editorStore";
import type {
  JsonValue,
  NullplugDiagnostic,
  NullplugMutation,
  NullplugYield,
} from "../../../shared/nullplug/types";
import type { NullplugUiPrimitive } from "../../../shared/nullplug/ui";

export type NullplugRenderStatus =
  | "idle"
  | "resolving"
  | "ready"
  | "submitting"
  | "streaming"
  | "error";

export interface NullplugResolutionRefs {
  frameId?: string;
  rootDropId?: string;
  branchId?: string;
  versionId?: number;
  callId?: string;
  sourceContentHash?: string;
  renderedContentHash?: string;
}

export interface NullplugRuntimeSelection {
  callId: string;
  status: NullplugRenderStatus;
  content?: string;
  primitives: NullplugUiPrimitive[];
  state: Record<string, JsonValue>;
  stateValue?: JsonValue;
  diagnostics: NullplugDiagnostic[];
  mutations: NullplugMutation[];
  yields: NullplugYield[];
  refs: NullplugResolutionRefs;
}

const isRecord = (value: JsonValue | undefined): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const metadataCallId = (metadata: Record<string, JsonValue> | undefined): string | undefined => {
  const value = metadata?.callId;
  return typeof value === "string" ? value : undefined;
};

export const readJsonPath = (
  value: Record<string, JsonValue>,
  path: readonly string[] = [],
): JsonValue | undefined => {
  let cursor: JsonValue | undefined = value;
  for (const part of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
};

const scopedStateForCall = (
  state: Record<string, JsonValue>,
  callId: string | undefined,
): Record<string, JsonValue> => {
  if (!callId) return state;
  const nested = state[callId];
  return isRecord(nested) ? nested : state;
};

const statusForFrame = (frame: EditorRenderFrame | null): NullplugRenderStatus => {
  if (!frame) return "idle";
  if (frame.status === "final") return "ready";
  if (frame.status === "error") return "error";
  return "resolving";
};

const firstCallId = (
  renderState: EditorNullplugRenderState,
  requestedCallId?: string,
): string =>
  requestedCallId ??
  renderState.callIds[0] ??
  renderState.uiPrimitives.find((primitive) => primitive.source?.callId)?.source
    ?.callId ??
  "document";

export const selectNullplugRuntime = (
  renderState: EditorNullplugRenderState,
  frame: EditorRenderFrame | null,
  options: { callId?: string; path?: readonly string[] } = {},
): NullplugRuntimeSelection => {
  const callId = firstCallId(renderState, options.callId);
  const scopedState = scopedStateForCall(renderState.uiState, options.callId);
  const primitives = options.callId
    ? renderState.uiPrimitives.filter(
        (primitive) => primitive.source?.callId === options.callId,
      )
    : renderState.uiPrimitives;
  const mutations = options.callId
    ? renderState.mutations.filter(
        (mutation) =>
          mutation.kind !== "ui.state.patch" || mutation.callId === options.callId,
      )
    : renderState.mutations;
  const yields = options.callId
    ? renderState.yields.filter(
        (entry) => metadataCallId(entry.metadata) === options.callId,
      )
    : renderState.yields;

  return {
    callId,
    status: statusForFrame(frame),
    primitives,
    state: scopedState,
    stateValue: options.path ? readJsonPath(scopedState, options.path) : undefined,
    diagnostics: renderState.diagnostics,
    mutations,
    yields,
    refs: {
      frameId: frame?.frameId,
      rootDropId: frame?.rootDropId,
      branchId: frame?.branchId,
      versionId: frame?.versionId,
      callId,
      sourceContentHash: frame?.sourceContentHash,
      renderedContentHash: frame?.renderedContentHash,
    },
  };
};

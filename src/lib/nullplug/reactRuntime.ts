import type {
  EditorNullplugRenderState,
  EditorRenderFrame,
} from "../../stores/editorStore";
import type { DropRuntimeNullplugCallProvenance } from "../../../shared/drop/runtime";
import type { DropBranchRuntimeFact } from "../../../shared/drop/diff";
import type {
  JsonValue,
  NullplugDiagnostic,
  NullplugMutation,
  NullplugYield,
} from "../../../shared/nullplug/types";
import {
  applyNullplugUiStatePatch,
  nullplugUiResponseFactToYield,
  type NullplugUiPrimitive,
  type NullplugUiResponseFact,
} from "../../../shared/nullplug/ui";

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
  providerStatuses: NullplugProviderStatus[];
  state: Record<string, JsonValue>;
  diagnostics: NullplugDiagnostic[];
  mutations: NullplugMutation[];
  yields: NullplugYield[];
  refs: NullplugResolutionRefs;
}

/** User-facing provider and policy outcome for one nullplug invocation. */
export interface NullplugProviderStatus {
  index: number;
  pluginId: string;
  effectivePluginId: string;
  callIds: string[];
  status: "ready" | "blocked" | "conditional" | "failed";
  scope?: "local" | "remote";
  providerId?: string;
  version?: string;
  code?: string;
  message?: string;
}

/** One call-scoped JSON path observed independently from broad runtime state. */
export interface NullplugStatePathOptions {
  callId: string;
  path: readonly string[];
}

const EMPTY_SCOPED_STATE: Record<string, JsonValue> = {};

const isRecord = (
  value: JsonValue | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const metadataCallId = (
  metadata: Record<string, JsonValue> | undefined,
): string | undefined => {
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
  return isRecord(nested) ? nested : EMPTY_SCOPED_STATE;
};

const factCallId = (fact: DropBranchRuntimeFact): string | undefined =>
  fact.fact.kind === "ui.response" ? fact.fact.source.callId : fact.fact.callId;

const factMatchesFinalFrame = (
  fact: DropBranchRuntimeFact,
  frame: EditorRenderFrame | null,
): boolean => {
  if (
    !frame ||
    frame.status !== "final" ||
    !frame.rootDropId ||
    !frame.branchId ||
    fact.rootDropId !== frame.rootDropId ||
    fact.branchId !== frame.branchId
  ) {
    return false;
  }

  const sourceContentHash = fact.fact.source.sourceContentHash;
  if (sourceContentHash) {
    if (sourceContentHash !== frame.sourceContentHash) return false;
  } else {
    const snapshotId = fact.fact.source.snapshotId;
    if (
      snapshotId !== undefined &&
      frame.versionId !== undefined &&
      snapshotId !== frame.versionId
    ) {
      return false;
    }
  }

  const callId = factCallId(fact);
  return Boolean(callId && frame.nullplugCallIds.includes(callId));
};

const includesResponseFact = (
  yields: readonly NullplugYield[],
  fact: NullplugUiResponseFact,
): boolean =>
  yields.some(
    (yieldValue) =>
      yieldValue.kind === "ui.response" &&
      isRecord(yieldValue.value) &&
      yieldValue.value.id === fact.id &&
      yieldValue.value.primitiveId === fact.primitiveId,
  );

/**
 * Applies branch-runtime facts only when they target the current final frame and one
 * of its call ids. This prevents delayed facts from reviving stale render output.
 */
export const applyBranchRuntimeFacts = (
  renderState: EditorNullplugRenderState,
  frame: EditorRenderFrame | null,
  facts: readonly DropBranchRuntimeFact[],
): EditorNullplugRenderState => {
  let uiState = renderState.uiState;
  let yields = renderState.yields;
  let runtimeFactIds = renderState.runtimeFactIds ?? [];
  let appliedFact = false;

  facts.forEach((event) => {
    if (!factMatchesFinalFrame(event, frame)) return;
    if (runtimeFactIds.includes(event.factId)) return;
    const callId = factCallId(event);
    if (!callId) return;

    if (event.fact.kind === "ui.state.snapshot") {
      uiState = { ...uiState, [callId]: event.fact.state };
      runtimeFactIds = [...runtimeFactIds, event.factId];
      appliedFact = true;
      return;
    }

    if (event.fact.kind === "ui.state.patch") {
      uiState = {
        ...uiState,
        [callId]: applyNullplugUiStatePatch(
          scopedStateForCall(uiState, callId),
          event.fact.patch,
        ),
      };
      runtimeFactIds = [...runtimeFactIds, event.factId];
      appliedFact = true;
      return;
    }

    if (!includesResponseFact(yields, event.fact)) {
      const yielded = nullplugUiResponseFactToYield(event.fact);
      yields = [
        ...yields,
        {
          ...yielded,
          metadata: {
            ...yielded.metadata,
            callId,
          },
        },
      ];
    }
    runtimeFactIds = [...runtimeFactIds, event.factId];
    appliedFact = true;
  });

  if (!appliedFact) {
    return renderState;
  }
  return { ...renderState, uiState, yields, runtimeFactIds };
};

/** Selects one call-scoped JSON value for an Object.is subscription. */
export const selectNullplugStatePath = (
  renderState: EditorNullplugRenderState,
  options: NullplugStatePathOptions,
): JsonValue | undefined =>
  readJsonPath(
    scopedStateForCall(renderState.uiState, options.callId),
    options.path,
  );

const providerStatusForCall = (
  call: DropRuntimeNullplugCallProvenance,
): NullplugProviderStatus => {
  const policyDiagnostic = call.diagnostics.find((entry) =>
    entry.code?.startsWith("policy_"),
  );
  const code = call.failure?.code ?? policyDiagnostic?.code;
  const status =
    call.status === "resolved"
      ? "ready"
      : code === "policy_conditional"
        ? "conditional"
        : call.status === "blocked"
          ? "blocked"
          : "failed";

  return {
    index: call.index,
    pluginId: call.pluginId,
    effectivePluginId: call.resolution?.pluginId ?? call.pluginId,
    callIds: call.callIds,
    status,
    scope: call.resolution?.scope,
    providerId: call.resolution?.providerId,
    version: call.resolution?.version,
    code,
    message: call.failure?.message ?? policyDiagnostic?.message,
  };
};

/** Derives ordered provider/policy status without duplicating render-frame state. */
export const selectNullplugProviderStatuses = (
  calls: readonly DropRuntimeNullplugCallProvenance[],
  callId?: string,
): NullplugProviderStatus[] =>
  calls
    .filter((call) => !callId || call.callIds.includes(callId))
    .map(providerStatusForCall);

const statusForFrame = (
  frame: EditorRenderFrame | null,
): NullplugRenderStatus => {
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

const primitiveMatchesCallId = (
  primitive: NullplugUiPrimitive,
  callId: string,
): boolean =>
  primitive.source?.callId === callId ||
  (primitive.kind === "card" &&
    (primitive.actions ?? []).some(
      (action) => action.source?.callId === callId,
    ));

export const selectNullplugRuntime = (
  renderState: EditorNullplugRenderState,
  frame: EditorRenderFrame | null,
  options: { callId?: string } = {},
): NullplugRuntimeSelection => {
  const callId = firstCallId(renderState, options.callId);
  const scopedState = scopedStateForCall(renderState.uiState, options.callId);
  const primitives = options.callId
    ? renderState.uiPrimitives.filter((primitive) =>
        primitiveMatchesCallId(primitive, options.callId!),
      )
    : renderState.uiPrimitives;
  const mutations = options.callId
    ? renderState.mutations.filter(
        (mutation) =>
          mutation.kind !== "ui.state.patch" ||
          mutation.callId === options.callId,
      )
    : renderState.mutations;
  const yields = options.callId
    ? renderState.yields.filter(
        (entry) => metadataCallId(entry.metadata) === options.callId,
      )
    : renderState.yields;
  const frameCalls = frame?.status === "final" ? frame.nullplugCalls : [];
  const calls = options.callId
    ? frameCalls.filter((call) =>
        call.callIds.includes(options.callId!),
      )
    : frameCalls;

  return {
    callId,
    status: statusForFrame(frame),
    primitives,
    providerStatuses: selectNullplugProviderStatuses(calls),
    state: scopedState,
    diagnostics: options.callId
      ? calls.flatMap((call) => call.diagnostics)
      : renderState.diagnostics,
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

const shallowReferenceArrayEqual = <T>(
  left: readonly T[],
  right: readonly T[],
): boolean =>
  left === right ||
  (left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index])));

const refsEqual = (
  left: NullplugResolutionRefs,
  right: NullplugResolutionRefs,
): boolean =>
  left.frameId === right.frameId &&
  left.rootDropId === right.rootDropId &&
  left.branchId === right.branchId &&
  left.versionId === right.versionId &&
  left.callId === right.callId &&
  left.sourceContentHash === right.sourceContentHash &&
  left.renderedContentHash === right.renderedContentHash;

const providerStatusesEqual = (
  left: readonly NullplugProviderStatus[],
  right: readonly NullplugProviderStatus[],
): boolean =>
  left === right ||
  (left.length === right.length &&
    left.every((status, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        status.index === other.index &&
        status.pluginId === other.pluginId &&
        status.effectivePluginId === other.effectivePluginId &&
        status.status === other.status &&
        status.scope === other.scope &&
        status.providerId === other.providerId &&
        status.version === other.version &&
        status.code === other.code &&
        status.message === other.message &&
        shallowReferenceArrayEqual(status.callIds, other.callIds)
      );
    }));

/** Equality boundary used to suppress unrelated editor-store rerenders. */
export const areNullplugRuntimeSelectionsEqual = (
  left: NullplugRuntimeSelection,
  right: NullplugRuntimeSelection,
): boolean =>
  left.callId === right.callId &&
  left.status === right.status &&
  left.content === right.content &&
  Object.is(left.state, right.state) &&
  shallowReferenceArrayEqual(left.primitives, right.primitives) &&
  providerStatusesEqual(left.providerStatuses, right.providerStatuses) &&
  shallowReferenceArrayEqual(left.diagnostics, right.diagnostics) &&
  shallowReferenceArrayEqual(left.mutations, right.mutations) &&
  shallowReferenceArrayEqual(left.yields, right.yields) &&
  refsEqual(left.refs, right.refs);

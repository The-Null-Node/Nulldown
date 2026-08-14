import type { DropRuntimeNullplugCallProvenance } from "../../../shared/drop/runtime";
import {
  createNullplugRuntime,
  isNullplugRuntimeError,
  NullplugRuntimeError,
  type NullplugRuntimeResolver,
  type VoidNullplugRuntime,
} from "../../../shared/nullplug/runtime";
import type {
  JsonValue,
  NullplugDiagnostic,
  NullplugInvokeRequest,
  NullplugMutation,
  NullplugRuntimeResolution,
  NullplugYield,
} from "../../../shared/nullplug/types";
import type { NullplugUiPrimitive } from "../../../shared/nullplug/ui";
import {
  createRenderInvokeRequest,
  type RenderInvocationBlock,
  type RenderInvocationOptions,
} from "./renderDiscovery";
import { collectRenderCallIds, toRenderableDiff } from "./renderResult";
import {
  normalizeNullplugRuntimeReturn,
  validateNullplugRuntimeResult,
} from "./runtime";
import type {
  NullplugContext,
  NullplugHandler,
  RenderableDiff,
  RenderablePatch,
} from "./types";

export interface RenderInvocationResult {
  call: DropRuntimeNullplugCallProvenance;
  diff: RenderableDiff | null;
  uiPrimitives: NullplugUiPrimitive[];
  uiState: Record<string, JsonValue>;
  mutations: NullplugMutation[];
  yields: NullplugYield[];
  diagnostics: NullplugDiagnostic[];
}

const createLocalResolver = (
  entry: RenderInvocationBlock,
  context: NullplugContext,
  resolution: NullplugRuntimeResolution,
  setLocalPatch: (patch: RenderablePatch | null) => void,
): NullplugRuntimeResolver => ({
  resolve: () => ({
    resolution,
    invoke: async () => {
      let returned: Awaited<ReturnType<NullplugHandler>>;
      try {
        returned = await entry.handler!(context, entry.block.content, entry.block);
      } catch (error) {
        throw new Error(`Nullplug ${entry.block.id} handler failed.`, {
          cause: error,
        });
      }

      const normalized = normalizeNullplugRuntimeReturn(returned, entry.block);
      if (returned !== null && returned !== undefined && !normalized) {
        throw new NullplugRuntimeError(
          "invalid_result",
          `Nullplug ${entry.block.id} returned an invalid result.`,
          { resolution },
        );
      }
      setLocalPatch(normalized?.patch ?? null);
      return {
        result: normalized?.result ?? {},
        diagnostics: normalized?.diagnostics,
      };
    },
  }),
});

const invocationPolicy = (
  entry: RenderInvocationBlock,
  options: RenderInvocationOptions,
  fallbackResolution: NullplugRuntimeResolution | undefined,
  getLocalPatch: () => RenderablePatch | null,
  setLocalPatch: (patch: RenderablePatch | null) => void,
) => ({
  prepare: (request: NullplugInvokeRequest) => {
    const policies = options.runtimePolicy?.nullplugs;
    const invokePolicy =
      policies && Object.prototype.hasOwnProperty.call(policies, entry.block.id)
        ? policies[entry.block.id]?.invoke
        : undefined;
    if (invokePolicy === "deny" || invokePolicy === "conditional") {
      const conditional = invokePolicy === "conditional";
      throw new NullplugRuntimeError(
        conditional ? "policy_conditional" : "policy_denied",
        `Root policy ${conditional ? "requires conditional" : "denied"} nullplug invocation: ${entry.block.id}.`,
        { resolution: fallbackResolution },
      );
    }
    return request;
  },
  validate: (response: Awaited<ReturnType<VoidNullplugRuntime["invoke"]>>) => {
    const validated = validateNullplugRuntimeResult(
      {
        result: response.result,
        patch:
          getLocalPatch() ??
          (typeof response.result.content === "string"
            ? { text: response.result.content }
            : null),
        diagnostics: response.diagnostics ?? [],
      },
      { policy: options.runtimePolicy, pluginId: entry.block.id },
    );
    setLocalPatch(validated.patch);
    return {
      result: validated.result,
      diagnostics: validated.diagnostics,
      resolution: response.resolution,
    };
  },
});

const isBlockedCode = (code: string): boolean =>
  code === "policy_denied" || code === "policy_conditional";

/** Resolves and executes one block, returning render data plus durable provenance. */
export const invokeRenderBlock = async (
  entry: RenderInvocationBlock,
  index: number,
  context: NullplugContext,
  options: RenderInvocationOptions,
): Promise<RenderInvocationResult> => {
  const invokeRequest = createRenderInvokeRequest(entry.block, options);
  const fallbackResolution: NullplugRuntimeResolution | undefined = entry.handler
    ? {
        pluginId: entry.block.id,
        version: invokeRequest.call.version,
        providerId: options.providerId ?? invokeRequest.context.providerId,
        baseUrl: options.providerBaseUrl ?? invokeRequest.context.baseUrl,
        scope: "local",
      }
    : undefined;
  let localPatch: RenderablePatch | null = null;
  const resolvers: NullplugRuntimeResolver[] = [];
  if (entry.handler && fallbackResolution) {
    resolvers.push(
      createLocalResolver(entry, context, fallbackResolution, (patch) => {
        localPatch = patch;
      }),
    );
  }
  if (options.nullplugRuntime) {
    resolvers.push({
      resolve: () => (request) => options.nullplugRuntime!.invoke(request),
    });
  }

  const runtime = createNullplugRuntime({
    resolvers,
    policy: invocationPolicy(
      entry,
      options,
      fallbackResolution,
      () => localPatch,
      (patch) => {
        localPatch = patch;
      },
    ),
  });

  let runtimeResult: Awaited<ReturnType<typeof runtime.invoke>> | null = null;
  let callDiagnostics: NullplugDiagnostic[] = [];
  let callStatus: DropRuntimeNullplugCallProvenance["status"] = "resolved";
  let callResolution = fallbackResolution;
  let failure: DropRuntimeNullplugCallProvenance["failure"];
  const diagnostics: NullplugDiagnostic[] = [];

  try {
    runtimeResult = await runtime.invoke(invokeRequest);
  } catch (error) {
    const code = isNullplugRuntimeError(error) ? error.code : "invoke_failed";
    const message = isNullplugRuntimeError(error)
      ? error.message
      : `Nullplug ${entry.block.id} invocation failed.`;
    if (isNullplugRuntimeError(error) && error.resolution) {
      callResolution = error.resolution;
    }
    callStatus = isBlockedCode(code) ? "blocked" : "failed";
    failure = { code, message };
    if (code !== "unsupported_plugin") {
      callDiagnostics = [{ level: "error", code, message }];
      diagnostics.push(...callDiagnostics);
    }
  }

  const result = runtimeResult?.result;
  const callIds = result ? collectRenderCallIds(result) : [];
  if (runtimeResult) {
    callResolution = runtimeResult.resolution ?? fallbackResolution;
    callDiagnostics = runtimeResult.diagnostics ?? [];
    diagnostics.push(...callDiagnostics);
  }

  return {
    call: {
      index,
      sourceRange: entry.sourceRange,
      pluginId: entry.block.id,
      ...(callResolution ? { resolution: callResolution } : {}),
      status: callStatus,
      callIds,
      diagnostics: callDiagnostics,
      ...(failure ? { failure } : {}),
    },
    diff: toRenderableDiff(entry.block, localPatch),
    uiPrimitives: result?.uiPrimitives ?? [],
    uiState: result?.uiState ?? {},
    mutations: result?.mutations ?? [],
    yields: result?.yields ?? [],
    diagnostics,
  };
};

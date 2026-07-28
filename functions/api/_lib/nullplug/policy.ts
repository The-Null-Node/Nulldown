import {
  isRootRuntimePolicy,
  resolveRootRuntimePolicy,
  type RootRuntimePolicy,
} from "../../../../shared/nullplug/policy";
import { filterNullplugInvokeResponse } from "../../../../shared/nullplug/resultPolicy";
import {
  NullplugRuntimeError,
  type VoidRuntimePolicy,
} from "../../../../shared/nullplug/runtime";
import type { NullplugInvokeRequest } from "../../../../shared/nullplug/types";
import {
  readProviderDropPayload,
  type CloudflareProviderPayloadBindings,
} from "../drops/services/providerPayload";

/** Dependencies used to create Cloudflare root-policy enforcement. */
export interface CreateCloudflareRuntimePolicyOptions {
  /** Provider-readable drop storage and escrow access. */
  bindings: CloudflareProviderPayloadBindings;
  /** Built-ins that remain invokable when no caller root was supplied. */
  trustedPluginIds: readonly string[];
}

const callerRootId = (request: NullplugInvokeRequest): string | null => {
  const callRootId = request.call.caller.dropId;
  const contextRootId = request.context.callerDropId;
  if (callRootId && contextRootId && callRootId !== contextRootId) {
    throw new NullplugRuntimeError(
      "caller_mismatch",
      "Nullplug caller drop ids must match.",
    );
  }
  return callRootId ?? contextRootId ?? null;
};

const loadRootPolicy = async (
  bindings: CloudflareProviderPayloadBindings,
  rootDropId: string,
): Promise<RootRuntimePolicy> => {
  const root = await readProviderDropPayload(bindings, rootDropId);
  if (!root) {
    throw new NullplugRuntimeError(
      "policy_source_unreadable",
      "Provider could not read the caller root policy.",
    );
  }

  const runtimePolicy = root.payload.metadata?.runtimePolicy;
  if (runtimePolicy !== undefined && !isRootRuntimePolicy(runtimePolicy)) {
    throw new NullplugRuntimeError(
      "invalid_root_policy",
      "The caller root runtime policy is invalid.",
    );
  }
  return resolveRootRuntimePolicy(root.payload.metadata);
};

/** Creates a fail-closed policy service for Cloudflare nullplug invocations. */
export const createCloudflareRuntimePolicy = ({
  bindings,
  trustedPluginIds,
}: CreateCloudflareRuntimePolicyOptions): VoidRuntimePolicy => {
  const trustedPlugins = new Set(trustedPluginIds);
  const policyByPreparedRequest = new WeakMap<
    NullplugInvokeRequest,
    RootRuntimePolicy | null
  >();

  return {
    async prepare(request) {
      const rootDropId = callerRootId(request);
      const isTrusted = trustedPlugins.has(request.call.pluginId);
      if (!rootDropId) {
        if (!isTrusted) {
          throw new NullplugRuntimeError(
            "policy_source_required",
            "Remote nullplug invocation requires a caller root policy.",
          );
        }
        policyByPreparedRequest.set(request, null);
        return request;
      }

      const policy = await loadRootPolicy(bindings, rootDropId);
      const nullplugPolicies = policy.nullplugs;
      const pluginPolicy =
        nullplugPolicies &&
        Object.prototype.hasOwnProperty.call(
          nullplugPolicies,
          request.call.pluginId,
        )
          ? nullplugPolicies[request.call.pluginId]
          : undefined;
      if (pluginPolicy?.invoke === "deny") {
        throw new NullplugRuntimeError(
          "policy_denied",
          `Root policy denied nullplug ${request.call.pluginId}.`,
        );
      }
      if (pluginPolicy?.invoke === "conditional") {
        throw new NullplugRuntimeError(
          "policy_conditional",
          `Root policy requires conditional approval for ${request.call.pluginId}.`,
        );
      }
      if (!isTrusted && pluginPolicy?.invoke !== "allow") {
        throw new NullplugRuntimeError(
          "policy_denied",
          `Root policy did not authorize remote nullplug ${request.call.pluginId}.`,
        );
      }

      const policyCapabilities = pluginPolicy?.capabilities;
      const capabilities = policyCapabilities
        ? request.context.capabilities.filter((capability) =>
            policyCapabilities.includes(capability),
          )
        : request.context.capabilities;
      const prepared =
        capabilities === request.context.capabilities
          ? request
          : {
              ...request,
              context: { ...request.context, capabilities },
            };
      policyByPreparedRequest.set(prepared, policy);
      return prepared;
    },
    validate(response, request) {
      const policy = policyByPreparedRequest.get(request);
      return policy
        ? filterNullplugInvokeResponse(response, {
            policy,
            pluginId: request.call.pluginId,
          })
        : response;
    },
  };
};

import {
  isRuntimeGrantWithinMaxGrant,
  type RootRuntimePolicy,
  type RuntimeGrant,
} from "./policy";
import type {
  NullplugCall,
  NullplugDiagnostic,
  NullplugInvokeResponse,
  NullplugMutation,
  NullplugResult,
  NullplugStreamDescriptor,
} from "./types";

/** Root policy inputs used to filter a normalized nullplug response. */
export interface NullplugResultPolicyOptions {
  /** Root policy that constrains returned effects. */
  policy?: RootRuntimePolicy | null;
  /** Plugin that produced the returned response. */
  pluginId?: string;
}

const diagnostic = (
  level: NullplugDiagnostic["level"],
  message: string,
  code?: string,
): NullplugDiagnostic => ({ level, message, ...(code ? { code } : {}) });

const isDropWriteGrantAllowedByPolicy = (
  grant: RuntimeGrant,
  policy: RootRuntimePolicy,
): boolean => {
  const writePolicy = policy.drops?.write;
  if (grant.kind === "drop.diff.propose") {
    return writePolicy === "propose" || writePolicy === "branch";
  }
  if (grant.kind === "drop.diff.apply") {
    return writePolicy === "branch";
  }
  return false;
};

const isGrantAllowed = (
  grant: RuntimeGrant,
  policy: RootRuntimePolicy,
  maxGrants: readonly RuntimeGrant[],
): boolean =>
  isDropWriteGrantAllowedByPolicy(grant, policy) ||
  maxGrants.some((maxGrant) => isRuntimeGrantWithinMaxGrant(grant, maxGrant));

const mutationGrant = (mutation: NullplugMutation): RuntimeGrant => {
  if (mutation.kind === "drop.diff.propose") {
    return { kind: "drop.diff.propose", scope: "branch" };
  }
  if (mutation.kind === "drop.diff.apply") {
    return { kind: "drop.diff.apply", scope: "branch" };
  }
  if (mutation.kind === "metadata.patch") {
    return { kind: "metadata.patch", scope: "root" };
  }
  if (mutation.kind === "ui.state.patch") {
    return { kind: "ui.state.write", scope: "root", target: mutation.callId };
  }
  return { kind: "sidecar.write", scope: "root", target: mutation.target };
};

const proposeMutationGrant: RuntimeGrant = {
  kind: "drop.diff.propose",
  scope: "branch",
};

const applyMutationGrant: RuntimeGrant = {
  kind: "drop.diff.apply",
  scope: "branch",
};

const callGrant = (call: NullplugCall): RuntimeGrant => ({
  kind: "nullplug.invoke",
  target: call.pluginId,
});

const streamGrant = (stream: NullplugStreamDescriptor): RuntimeGrant => ({
  kind: "stream.open",
  target: stream.id,
});

const isStreamHostAllowed = (
  stream: NullplugStreamDescriptor,
  policy: RootRuntimePolicy,
): boolean => {
  if (!stream.url) return true;
  try {
    const parsed = new URL(stream.url);
    if (parsed.protocol !== "https:") return false;
    return (policy.network?.allowedHosts ?? []).includes(
      parsed.hostname.toLowerCase(),
    );
  } catch {
    return false;
  }
};

const normalizePolicyControlledMutations = (
  result: NullplugResult,
  policy: RootRuntimePolicy,
  maxGrants: readonly RuntimeGrant[],
): { mutations?: NullplugMutation[]; diagnostics: NullplugDiagnostic[] } => {
  const diagnostics: NullplugDiagnostic[] = [];
  const sourceMutations = [...(result.mutations ?? [])];
  const canProposeDiff = isGrantAllowed(
    proposeMutationGrant,
    policy,
    maxGrants,
  );
  const canApplyDiff = isGrantAllowed(applyMutationGrant, policy, maxGrants);

  if (result.diffs) {
    sourceMutations.unshift({
      kind: "drop.diff.propose",
      envelope: result.diffs,
      reason: "Normalized from legacy top-level diffs.",
    });
    diagnostics.push(
      diagnostic(
        "info",
        "Normalized top-level diffs into a proposed mutation.",
        "diffs_normalized",
      ),
    );
  }

  if (!sourceMutations.length) return { diagnostics };

  const mutations: NullplugMutation[] = [];
  let rejected = 0;
  let downgraded = 0;

  sourceMutations.forEach((mutation) => {
    if (mutation.kind === "drop.diff.apply") {
      if (canApplyDiff) {
        mutations.push(mutation);
      } else if (canProposeDiff) {
        downgraded += 1;
        mutations.push({
          kind: "drop.diff.propose",
          envelope: mutation.envelope,
          reason: `Downgraded from apply mutation ${mutation.grantId}.`,
        });
      } else {
        rejected += 1;
      }
      return;
    }

    if (mutation.kind === "drop.diff.propose") {
      if (canProposeDiff) mutations.push(mutation);
      else rejected += 1;
      return;
    }

    if (isGrantAllowed(mutationGrant(mutation), policy, maxGrants)) {
      mutations.push(mutation);
    } else {
      rejected += 1;
    }
  });

  if (downgraded > 0) {
    diagnostics.push(
      diagnostic(
        "warn",
        "Root policy downgraded one or more apply mutations to proposals.",
        "policy_mutation_downgraded",
      ),
    );
  }
  if (rejected > 0) {
    diagnostics.push(
      diagnostic(
        "warn",
        "Root policy rejected one or more nullplug mutations.",
        "policy_mutation_rejected",
      ),
    );
  }

  return { mutations: mutations.length ? mutations : undefined, diagnostics };
};

/** Filters returned nullplug effects against the already-resolved root policy. */
export const filterNullplugInvokeResponse = (
  response: NullplugInvokeResponse,
  options: NullplugResultPolicyOptions = {},
): NullplugInvokeResponse => {
  const policy = options.policy;
  if (!policy) return response;

  const pluginId = options.pluginId;
  const nullplugPolicies = policy.nullplugs;
  const pluginPolicy =
    pluginId &&
    nullplugPolicies &&
    Object.prototype.hasOwnProperty.call(nullplugPolicies, pluginId)
      ? nullplugPolicies[pluginId]
      : undefined;
  const diagnostics = [...(response.diagnostics ?? [])];
  if (pluginPolicy?.invoke === "deny") {
    return {
      ...response,
      result: {},
      diagnostics: [
        ...diagnostics,
        diagnostic(
          "error",
          `Root policy denied nullplug invocation${pluginId ? `: ${pluginId}` : ""}.`,
          "policy_denied",
        ),
      ],
    };
  }
  if (pluginPolicy?.invoke === "conditional") {
    return {
      ...response,
      result: {},
      diagnostics: [
        ...diagnostics,
        diagnostic(
          "warn",
          `Root policy requires conditional nullplug invocation${pluginId ? `: ${pluginId}` : ""}.`,
          "policy_conditional",
        ),
      ],
    };
  }

  const maxGrants = pluginPolicy?.maxGrants ?? [];
  const result: NullplugResult = { ...response.result };
  const normalizedMutations = normalizePolicyControlledMutations(
    result,
    policy,
    maxGrants,
  );
  delete result.diffs;
  if (normalizedMutations.mutations) result.mutations = normalizedMutations.mutations;
  else delete result.mutations;
  diagnostics.push(...normalizedMutations.diagnostics);

  if (result.calls) {
    const allowed = result.calls.filter((call) =>
      isGrantAllowed(callGrant(call), policy, maxGrants),
    );
    if (allowed.length !== result.calls.length) {
      diagnostics.push(
        diagnostic(
          "warn",
          "Root policy rejected one or more nested nullplug calls.",
          "policy_nested_call_rejected",
        ),
      );
    }
    if (allowed.length) result.calls = allowed;
    else delete result.calls;
  }

  if (result.streams) {
    const allowed = result.streams.filter(
      (stream) =>
        isStreamHostAllowed(stream, policy) &&
        isGrantAllowed(streamGrant(stream), policy, maxGrants),
    );
    if (allowed.length !== result.streams.length) {
      diagnostics.push(
        diagnostic(
          "warn",
          "Root policy rejected one or more nullplug streams.",
          "policy_stream_rejected",
        ),
      );
    }
    if (allowed.length) result.streams = allowed;
    else delete result.streams;
  }

  return {
    ...response,
    result,
    diagnostics: diagnostics.length ? diagnostics : undefined,
  };
};

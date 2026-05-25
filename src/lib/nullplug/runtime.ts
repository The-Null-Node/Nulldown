import {
  isNullplugInvokeResponse,
  isNullplugResult,
  type NullplugCall,
  type NullplugDiagnostic,
  type NullplugMutation,
  type NullplugResult,
  type NullplugStreamDescriptor,
} from "../../../shared/nullplug/types";
import {
  isRuntimeGrantWithinMaxGrant,
  type RootRuntimePolicy,
  type RuntimeGrant,
} from "../../../shared/nullplug/policy";
import type { PluginBlock, RenderableDiff, RenderablePatch } from "./types";

export interface NormalizedNullplugRuntimeResult {
  result: NullplugResult;
  patch: RenderablePatch | null;
  diagnostics: NullplugDiagnostic[];
}

export interface NullplugRuntimePolicyOptions {
  policy?: RootRuntimePolicy | null;
  pluginId?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isRenderableDiff = (value: unknown): value is RenderableDiff =>
  isRecord(value) &&
  typeof value.start === "number" &&
  typeof value.end === "number" &&
  typeof value.text === "string";

const isRenderablePatch = (value: unknown): value is RenderablePatch =>
  isRenderableDiff(value) ||
  (isRecord(value) &&
    typeof value.text === "string" &&
    value.start === undefined &&
    value.end === undefined);

const resultContentToPatch = (
  result: NullplugResult,
  _block: PluginBlock,
): RenderablePatch | null => {
  if (typeof result.content !== "string") {
    return null;
  }

  return { text: result.content };
};

const diagnostic = (
  level: NullplugDiagnostic["level"],
  message: string,
): NullplugDiagnostic => ({ level, message });

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
    const allowedHosts = policy.network?.allowedHosts ?? [];
    return allowedHosts.includes(parsed.hostname.toLowerCase());
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
  const canProposeDiff = isGrantAllowed(proposeMutationGrant, policy, maxGrants);
  const canApplyDiff = isGrantAllowed(applyMutationGrant, policy, maxGrants);

  if (result.diffs) {
    sourceMutations.unshift({
      kind: "drop.diff.propose",
      envelope: result.diffs,
      reason: "Normalized from legacy top-level diffs.",
    });
    diagnostics.push(
      diagnostic("info", "Normalized top-level diffs into a proposed mutation."),
    );
  }

  if (!sourceMutations.length) {
    return { diagnostics };
  }

  const mutations: NullplugMutation[] = [];
  let rejected = 0;
  let downgraded = 0;

  sourceMutations.forEach((mutation) => {
    if (mutation.kind === "drop.diff.apply") {
      if (canApplyDiff) {
        mutations.push(mutation);
        return;
      }
      if (canProposeDiff) {
        downgraded += 1;
        mutations.push({
          kind: "drop.diff.propose",
          envelope: mutation.envelope,
          reason: `Downgraded from apply mutation ${mutation.grantId}.`,
        });
        return;
      }
      rejected += 1;
      return;
    }

    if (mutation.kind === "drop.diff.propose") {
      if (canProposeDiff) {
        mutations.push(mutation);
      } else {
        rejected += 1;
      }
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
      diagnostic("warn", "Root policy downgraded one or more apply mutations to proposals."),
    );
  }
  if (rejected > 0) {
    diagnostics.push(
      diagnostic("warn", "Root policy rejected one or more nullplug mutations."),
    );
  }

  return {
    mutations: mutations.length ? mutations : undefined,
    diagnostics,
  };
};

export const validateNullplugRuntimeResult = (
  normalized: NormalizedNullplugRuntimeResult,
  options: NullplugRuntimePolicyOptions = {},
): NormalizedNullplugRuntimeResult => {
  const policy = options.policy;
  if (!policy) {
    return normalized;
  }

  const pluginId = options.pluginId;
  const pluginPolicy = pluginId ? policy.nullplugs?.[pluginId] : undefined;
  if (pluginPolicy?.invoke === "deny") {
    return {
      result: {},
      patch: null,
      diagnostics: [
        ...normalized.diagnostics,
        diagnostic("error", `Root policy denied nullplug invocation${pluginId ? `: ${pluginId}` : ""}.`),
      ],
    };
  }
  if (pluginPolicy?.invoke === "conditional") {
    return {
      result: {},
      patch: null,
      diagnostics: [
        ...normalized.diagnostics,
        diagnostic(
          "warn",
          `Root policy requires conditional nullplug invocation${pluginId ? `: ${pluginId}` : ""}.`,
        ),
      ],
    };
  }

  const maxGrants = pluginPolicy?.maxGrants ?? [];
  const result: NullplugResult = { ...normalized.result };
  const diagnostics = [...normalized.diagnostics];

  const normalizedMutations = normalizePolicyControlledMutations(
    result,
    policy,
    maxGrants,
  );
  delete result.diffs;
  if (normalizedMutations.mutations) {
    result.mutations = normalizedMutations.mutations;
  } else {
    delete result.mutations;
  }
  diagnostics.push(...normalizedMutations.diagnostics);

  if (result.calls) {
    const allowed = result.calls.filter((call) =>
      isGrantAllowed(callGrant(call), policy, maxGrants),
    );
    if (allowed.length !== result.calls.length) {
      diagnostics.push(
        diagnostic("warn", "Root policy rejected one or more nested nullplug calls."),
      );
    }
    if (allowed.length) {
      result.calls = allowed;
    } else {
      delete result.calls;
    }
  }

  if (result.streams) {
    const allowed = result.streams.filter(
      (stream) =>
        isStreamHostAllowed(stream, policy) &&
        isGrantAllowed(streamGrant(stream), policy, maxGrants),
    );
    if (allowed.length !== result.streams.length) {
      diagnostics.push(
        diagnostic("warn", "Root policy rejected one or more nullplug streams."),
      );
    }
    if (allowed.length) {
      result.streams = allowed;
    } else {
      delete result.streams;
    }
  }

  return {
    result,
    patch: normalized.patch,
    diagnostics,
  };
};

export const normalizeNullplugRuntimeReturn = (
  value: unknown,
  block: PluginBlock,
  options: NullplugRuntimePolicyOptions = {},
): NormalizedNullplugRuntimeResult | null => {
  let normalized: NormalizedNullplugRuntimeResult | null = null;

  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    normalized = {
      result: { content: value },
      patch: { text: value },
      diagnostics: [],
    };
  } else if (isNullplugInvokeResponse(value)) {
    normalized = {
      result: value.result,
      patch: resultContentToPatch(value.result, block),
      diagnostics: value.diagnostics ?? [],
    };
  } else if (isNullplugResult(value)) {
    normalized = {
      result: value,
      patch: resultContentToPatch(value, block),
      diagnostics: [],
    };
  } else if (isRenderablePatch(value)) {
    normalized = {
      result: { content: value.text },
      patch: value,
      diagnostics: [],
    };
  }

  return normalized ? validateNullplugRuntimeResult(normalized, options) : null;
};

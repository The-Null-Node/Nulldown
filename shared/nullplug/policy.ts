import type { JsonValue } from "./types";

export const DEFAULT_RUNTIME_NETWORK_ALLOWLIST = [
  "www.youtube.com",
  "youtube.com",
  "www.youtube-nocookie.com",
  "youtu.be",
  "player.vimeo.com",
  "vimeo.com",
] as const;

export type DropReadPolicy = "none" | "self" | "linked" | "explicit";
export type DropWritePolicy = "none" | "propose" | "branch";

export type RuntimeGrantKind =
  | "network.fetch"
  | "drop.read"
  | "drop.diff.propose"
  | "drop.diff.apply"
  | "metadata.patch"
  | "ui.state.write"
  | "sidecar.write"
  | "stream.open"
  | "nullplug.invoke"
  | "policy.evaluate";

export type RuntimeGrantScope =
  | "self"
  | "linked"
  | "explicit"
  | "branch"
  | "root"
  | "network";

export interface RuntimeGrant {
  kind: RuntimeGrantKind;
  scope?: RuntimeGrantScope;
  target?: string;
  capabilities?: string[];
  expiresAt?: number;
}

export interface NullplugPermissionPolicy {
  invoke?: "deny" | "allow" | "conditional";
  capabilities?: string[];
  maxGrants?: RuntimeGrant[];
}

export interface RootRuntimePolicy {
  version: 1;
  network?: { allowedHosts: string[] };
  drops?: {
    read?: DropReadPolicy;
    write?: DropWritePolicy;
  };
  nullplugs?: Record<string, NullplugPermissionPolicy>;
  conditionalGrants?: ConditionalGrant[];
}

export type CallableRef =
  | { kind: "builtin.nullplug"; id: string }
  | { kind: "remote.nullplug"; id: string; endpoint: string }
  | { kind: "null.call"; id: string }
  | { kind: "policy.handler"; id: string };

export interface GrantTrigger {
  kind?: "ui.response" | "nullplug.result" | "event.metadata" | "manual";
  responseOf?: string;
  field?: string;
  eventKind?: string;
}

export interface PolicyInputSelector {
  responses?: string[];
  metadata?: string[];
  resolvedHeapRefs?: string[];
}

export interface ConditionalGrant {
  id: string;
  trigger: GrantTrigger;
  evaluator: CallableRef;
  maxGrant: RuntimeGrant;
  input?: PolicyInputSelector;
  onError?: "deny" | "defer";
}

export interface GrantEvaluationRequest {
  grantId: string;
  rootDropId: string;
  branchId?: string;
  snapshotId?: number;
  requested: RuntimeGrant;
  trigger: GrantTrigger;
  facts: {
    responses?: Record<string, JsonValue>;
    metadata?: Record<string, JsonValue>;
    resolvedHeapRefs?: string[];
  };
}

export interface PolicyDecisionValue {
  decision: "allow" | "deny" | "defer";
  grant?: RuntimeGrant;
  reason?: string;
  expiresAt?: number;
  metadata?: Record<string, JsonValue>;
}

const HOSTNAME_PATTERN = /^[a-z0-9.-]+$/;

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

const normalizeAllowedHostEntry = (value: string): string | null => {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;

  try {
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return null;
      }
      return parsed.hostname.toLowerCase() || null;
    }

    if (trimmed.startsWith("//")) {
      const parsed = new URL(`https:${trimmed}`);
      return parsed.hostname.toLowerCase() || null;
    }

    const parsed = new URL(`https://${trimmed}`);
    return parsed.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
};

export const normalizeAllowedHosts = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const normalized: string[] = [];

  values.forEach((value) => {
    const host = normalizeAllowedHostEntry(value);
    if (!host) return;
    if (!HOSTNAME_PATTERN.test(host) && host !== "localhost") return;
    if (seen.has(host)) return;
    seen.add(host);
    normalized.push(host);
  });

  return normalized;
};

const isDropReadPolicy = (value: unknown): value is DropReadPolicy =>
  value === "none" ||
  value === "self" ||
  value === "linked" ||
  value === "explicit";

const isDropWritePolicy = (value: unknown): value is DropWritePolicy =>
  value === "none" || value === "propose" || value === "branch";

const isRuntimeGrantKind = (value: unknown): value is RuntimeGrantKind =>
  value === "network.fetch" ||
  value === "drop.read" ||
  value === "drop.diff.propose" ||
  value === "drop.diff.apply" ||
  value === "metadata.patch" ||
  value === "ui.state.write" ||
  value === "sidecar.write" ||
  value === "stream.open" ||
  value === "nullplug.invoke" ||
  value === "policy.evaluate";

const isRuntimeGrantScope = (value: unknown): value is RuntimeGrantScope =>
  value === "self" ||
  value === "linked" ||
  value === "explicit" ||
  value === "branch" ||
  value === "root" ||
  value === "network";

export const isRuntimeGrant = (value: unknown): value is RuntimeGrant => {
  if (!isRecord(value)) return false;
  if (!isRuntimeGrantKind(value.kind)) return false;
  if (value.scope !== undefined && !isRuntimeGrantScope(value.scope)) return false;
  if (value.target !== undefined && !isString(value.target)) return false;
  if (value.capabilities !== undefined && !isStringArray(value.capabilities)) {
    return false;
  }
  if (value.expiresAt !== undefined && !isNumber(value.expiresAt)) return false;
  return true;
};

const isCallableRef = (value: unknown): value is CallableRef => {
  if (!isRecord(value)) return false;
  if (value.kind === "builtin.nullplug") return isString(value.id);
  if (value.kind === "remote.nullplug") {
    return isString(value.id) && isString(value.endpoint);
  }
  if (value.kind === "null.call") return isString(value.id);
  if (value.kind === "policy.handler") return isString(value.id);
  return false;
};

const isGrantTrigger = (value: unknown): value is GrantTrigger => {
  if (!isRecord(value)) return false;
  if (
    value.kind !== undefined &&
    value.kind !== "ui.response" &&
    value.kind !== "nullplug.result" &&
    value.kind !== "event.metadata" &&
    value.kind !== "manual"
  ) {
    return false;
  }
  if (value.responseOf !== undefined && !isString(value.responseOf)) return false;
  if (value.field !== undefined && !isString(value.field)) return false;
  if (value.eventKind !== undefined && !isString(value.eventKind)) return false;
  return true;
};

const isPolicyInputSelector = (value: unknown): value is PolicyInputSelector => {
  if (!isRecord(value)) return false;
  if (value.responses !== undefined && !isStringArray(value.responses)) return false;
  if (value.metadata !== undefined && !isStringArray(value.metadata)) return false;
  if (
    value.resolvedHeapRefs !== undefined &&
    !isStringArray(value.resolvedHeapRefs)
  ) {
    return false;
  }
  return true;
};

export const isConditionalGrant = (value: unknown): value is ConditionalGrant => {
  if (!isRecord(value)) return false;
  if (!isString(value.id)) return false;
  if (!isGrantTrigger(value.trigger)) return false;
  if (!isCallableRef(value.evaluator)) return false;
  if (!isRuntimeGrant(value.maxGrant)) return false;
  if (value.input !== undefined && !isPolicyInputSelector(value.input)) {
    return false;
  }
  if (value.onError !== undefined && value.onError !== "deny" && value.onError !== "defer") {
    return false;
  }
  return true;
};

const isNullplugPermissionPolicy = (
  value: unknown,
): value is NullplugPermissionPolicy => {
  if (!isRecord(value)) return false;
  if (
    value.invoke !== undefined &&
    value.invoke !== "deny" &&
    value.invoke !== "allow" &&
    value.invoke !== "conditional"
  ) {
    return false;
  }
  if (value.capabilities !== undefined && !isStringArray(value.capabilities)) {
    return false;
  }
  if (
    value.maxGrants !== undefined &&
    (!Array.isArray(value.maxGrants) || !value.maxGrants.every(isRuntimeGrant))
  ) {
    return false;
  }
  return true;
};

export const isRootRuntimePolicy = (
  value: unknown,
): value is RootRuntimePolicy => {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (value.network !== undefined) {
    if (!isRecord(value.network)) return false;
    if (!isStringArray(value.network.allowedHosts)) return false;
  }
  if (value.drops !== undefined) {
    if (!isRecord(value.drops)) return false;
    if (value.drops.read !== undefined && !isDropReadPolicy(value.drops.read)) {
      return false;
    }
    if (value.drops.write !== undefined && !isDropWritePolicy(value.drops.write)) {
      return false;
    }
  }
  if (value.nullplugs !== undefined) {
    if (!isRecord(value.nullplugs)) return false;
    if (!Object.values(value.nullplugs).every(isNullplugPermissionPolicy)) {
      return false;
    }
  }
  if (
    value.conditionalGrants !== undefined &&
    (!Array.isArray(value.conditionalGrants) ||
      !value.conditionalGrants.every(isConditionalGrant))
  ) {
    return false;
  }
  return true;
};

const normalizeRootRuntimePolicyCandidate = (
  value: unknown,
): RootRuntimePolicy | null => {
  if (!isRootRuntimePolicy(value)) return null;
  return {
    ...value,
    network: value.network
      ? { allowedHosts: normalizeAllowedHosts(value.network.allowedHosts) }
      : undefined,
  };
};

export const resolveRootRuntimePolicy = (
  metadata: { runtimePolicy?: unknown; allowedUrls?: unknown } | null | undefined,
  fallbackAllowedHosts: readonly string[] = DEFAULT_RUNTIME_NETWORK_ALLOWLIST,
): RootRuntimePolicy => {
  const fromRuntimePolicy = normalizeRootRuntimePolicyCandidate(
    metadata?.runtimePolicy,
  );
  const legacyAllowedHosts = Array.isArray(metadata?.allowedUrls)
    ? normalizeAllowedHosts(
        metadata.allowedUrls.filter((entry): entry is string => isString(entry)),
      )
    : normalizeAllowedHosts(fallbackAllowedHosts);

  if (fromRuntimePolicy) {
    return {
      ...fromRuntimePolicy,
      network: {
        allowedHosts: fromRuntimePolicy.network?.allowedHosts.length
          ? fromRuntimePolicy.network.allowedHosts
          : legacyAllowedHosts,
      },
    };
  }

  return {
    version: 1,
    network: { allowedHosts: legacyAllowedHosts },
  };
};

const includesAll = (requested: readonly string[], allowed: readonly string[]) => {
  const allowedSet = new Set(allowed);
  return requested.every((entry) => allowedSet.has(entry));
};

export const isRuntimeGrantWithinMaxGrant = (
  requested: RuntimeGrant,
  maxGrant: RuntimeGrant,
): boolean => {
  if (requested.kind !== maxGrant.kind) return false;
  if (maxGrant.scope !== undefined && requested.scope !== maxGrant.scope) {
    return false;
  }
  if (maxGrant.target !== undefined && requested.target !== maxGrant.target) {
    return false;
  }
  if (
    maxGrant.capabilities !== undefined &&
    !includesAll(requested.capabilities ?? [], maxGrant.capabilities)
  ) {
    return false;
  }
  if (maxGrant.expiresAt !== undefined) {
    if (requested.expiresAt === undefined) return false;
    if (requested.expiresAt > maxGrant.expiresAt) return false;
  }
  return true;
};

export const isPolicyDecisionValue = (
  value: unknown,
): value is PolicyDecisionValue => {
  if (!isRecord(value)) return false;
  if (
    value.decision !== "allow" &&
    value.decision !== "deny" &&
    value.decision !== "defer"
  ) {
    return false;
  }
  if (value.grant !== undefined && !isRuntimeGrant(value.grant)) return false;
  if (value.reason !== undefined && !isString(value.reason)) return false;
  if (value.expiresAt !== undefined && !isNumber(value.expiresAt)) return false;
  if (value.metadata !== undefined && !isJsonRecord(value.metadata)) return false;
  return true;
};

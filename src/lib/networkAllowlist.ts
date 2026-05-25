import {
  DEFAULT_RUNTIME_NETWORK_ALLOWLIST,
  normalizeAllowedHosts,
} from "../../shared/nullplug/policy";

/*
 Allowlist entries are stored as hostnames, not raw URLs, so the same policy can be
 applied consistently in the render pipeline, markdown renderer, and persisted settings.
 Normalization aggressively strips formatting differences to keep trust checks simple.
*/

export const DEFAULT_NETWORK_ALLOWLIST = DEFAULT_RUNTIME_NETWORK_ALLOWLIST;

export const normalizeNetworkAllowlist = (
  values: readonly string[],
): string[] => normalizeAllowedHosts(values);

export const resolveNetworkAllowlist = (
  value: unknown,
  fallback: readonly string[] = DEFAULT_NETWORK_ALLOWLIST,
): string[] => {
  if (!Array.isArray(value)) {
    return normalizeNetworkAllowlist(fallback);
  }

  return normalizeNetworkAllowlist(
    value.filter((entry): entry is string => typeof entry === "string"),
  );
};

export const parseNetworkAllowlistInput = (input: string): string[] => {
  const entries = input
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  return normalizeNetworkAllowlist(entries);
};

export const DEFAULT_NETWORK_ALLOWLIST = [
  "www.youtube.com",
  "youtube.com",
  "www.youtube-nocookie.com",
  "youtu.be",
  "player.vimeo.com",
  "vimeo.com",
] as const;

const HOSTNAME_PATTERN = /^[a-z0-9.-]+$/;

const normalizeNetworkAllowlistEntry = (value: string): string | null => {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

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

export const normalizeNetworkAllowlist = (
  values: readonly string[],
): string[] => {
  const seen = new Set<string>();
  const normalized: string[] = [];

  values.forEach((value) => {
    const host = normalizeNetworkAllowlistEntry(value);
    if (!host) {
      return;
    }

    if (!HOSTNAME_PATTERN.test(host) && host !== "localhost") {
      return;
    }

    if (seen.has(host)) {
      return;
    }

    seen.add(host);
    normalized.push(host);
  });

  return normalized;
};

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

export const DEFAULT_IFRAME_ALLOWLIST = [
  "www.youtube.com",
  "youtube.com",
  "www.youtube-nocookie.com",
  "youtu.be",
  "player.vimeo.com",
  "vimeo.com",
] as const;

const HOSTNAME_PATTERN = /^[a-z0-9.-]+$/;

const normalizeIframeAllowlistEntry = (value: string): string | null => {
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

export const normalizeIframeAllowlist = (
  values: readonly string[],
): string[] => {
  const seen = new Set<string>();
  const normalized: string[] = [];

  values.forEach((value) => {
    const host = normalizeIframeAllowlistEntry(value);
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

export const resolveIframeAllowlist = (
  value: unknown,
  fallback: readonly string[] = DEFAULT_IFRAME_ALLOWLIST,
): string[] => {
  if (!Array.isArray(value)) {
    return normalizeIframeAllowlist(fallback);
  }

  return normalizeIframeAllowlist(
    value.filter((entry): entry is string => typeof entry === "string"),
  );
};

export const parseIframeAllowlistInput = (input: string): string[] => {
  const entries = input
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  return normalizeIframeAllowlist(entries);
};

import { normalizeNetworkAllowlist } from "../networkAllowlist";
import type { NullplugCaller, NullplugContext } from "./types";

const normalizeEmbedCandidate = (rawUrl: string): string => {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return `https://${trimmed}`;
};

const createTrustedEmbedResolver = (allowedHosts: ReadonlySet<string>) =>
  (rawUrl: string): string | null => {
    const candidate = normalizeEmbedCandidate(rawUrl);
    if (!candidate) return null;

    try {
      const parsed = new URL(candidate);
      if (
        parsed.protocol !== "https:" ||
        !allowedHosts.has(parsed.hostname.toLowerCase())
      ) {
        return null;
      }
      return parsed.toString();
    } catch {
      return null;
    }
  };

/** Builds the bounded context exposed to local nullplug handlers. */
export const createRenderNullplugContext = (options: {
  allowedUrls: readonly string[];
  caller?: NullplugCaller;
  maxDepth?: number;
  resolveDrop?: NullplugContext["resolveDrop"];
  visitedDropIds?: Iterable<string>;
}): NullplugContext => {
  const allowedNetworkHosts = new Set(
    normalizeNetworkAllowlist(options.allowedUrls),
  );
  const visitedDropIds = new Set(options.visitedDropIds ?? []);
  if (options.caller?.dropId) visitedDropIds.add(options.caller.dropId);

  return {
    allowedNetworkHosts,
    toTrustedEmbedUrl: createTrustedEmbedResolver(allowedNetworkHosts),
    caller: options.caller ?? {},
    maxDepth: Math.max(1, options.maxDepth ?? 4),
    visitedDropIds,
    resolveDrop: options.resolveDrop,
  };
};

/** Neutralizes author-provided iframes before nullplug rendering begins. */
export const escapeRawIframeSyntax = (value: string): string =>
  value
    .replace(/<\s*iframe\b/gi, "&lt;iframe")
    .replace(/<\s*\/\s*iframe\s*>/gi, "&lt;/iframe&gt;");

/*
This pipeline resolves nullplug fenced blocks before markdown rendering. It is also a
security boundary: raw iframe syntax is neutralized first, plugin handlers only receive
trusted embed helpers, and partial renders are cancellable so stale async work does not
flash outdated preview output.
*/

import {
  DEFAULT_NETWORK_ALLOWLIST,
  normalizeNetworkAllowlist,
} from "../networkAllowlist";
import type { RootRuntimePolicy } from "../../../shared/nullplug/policy";
import type {
  JsonValue,
  NullplugDiagnostic,
  NullplugMutation,
  NullplugYield,
} from "../../../shared/nullplug/types";
import type { NullplugUiPrimitive } from "../../../shared/nullplug/ui";
import { parseNullplugBlocks } from "./parser";
import { resolveNullplug } from "./registry";
import { normalizeNullplugRuntimeReturn } from "./runtime";
import type {
  NullplugCaller,
  NullplugContext,
  NullplugHandler,
  PluginBlock,
  RenderableDiff,
  RenderablePatch,
} from "./types";
import "./plugins";

export interface RenderChunkStatus {
  processedBlocks: number;
  totalBlocks: number;
  progress: number;
}

export interface RenderPipelineOptions {
  allowedUrls?: readonly string[];
  chunkSize?: number;
  flushIntervalMs?: number;
  caller?: NullplugCaller;
  maxDepth?: number;
  runtimePolicy?: RootRuntimePolicy | null;
  resolveDrop?: NullplugContext["resolveDrop"];
  visitedDropIds?: Iterable<string>;
  onFlush?: (renderedMarkdown: string, status: RenderChunkStatus) => void;
  shouldCancel?: () => boolean;
}

export interface RenderPipelineResult {
  markdown: string;
  uiPrimitives: NullplugUiPrimitive[];
  uiState: Record<string, JsonValue>;
  mutations: NullplugMutation[];
  yields: NullplugYield[];
  diagnostics: NullplugDiagnostic[];
  status: RenderChunkStatus;
}

export class RenderCancelledError extends Error {
  constructor() {
    super("Render cancelled");
    this.name = "RenderCancelledError";
  }
}

const DEFAULT_CHUNK_SIZE = 6;
const DEFAULT_FLUSH_INTERVAL_MS = 24;

interface ResolvedPluginBlock {
  block: PluginBlock;
  handler: NullplugHandler;
}

const normalizeEmbedCandidate = (rawUrl: string): string => {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return "";
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (trimmed.startsWith("//")) {
    return `https:${trimmed}`;
  }

  return `https://${trimmed}`;
};

const createTrustedEmbedResolver = (allowedHosts: ReadonlySet<string>) => {
  return (rawUrl: string): string | null => {
    const candidate = normalizeEmbedCandidate(rawUrl);
    if (!candidate) {
      return null;
    }

    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "https:") {
        return null;
      }

      const host = parsed.hostname.toLowerCase();
      if (!allowedHosts.has(host)) {
        return null;
      }

      return parsed.toString();
    } catch {
      return null;
    }
  };
};

const createNullplugContext = (options: {
  allowedUrls: readonly string[];
  caller?: NullplugCaller;
  maxDepth?: number;
  resolveDrop?: NullplugContext["resolveDrop"];
  visitedDropIds?: Iterable<string>;
}): NullplugContext => {
  const { allowedUrls } = options;
  const allowedNetworkHosts = new Set(normalizeNetworkAllowlist(allowedUrls));
  const visitedDropIds = new Set(options.visitedDropIds ?? []);
  if (options.caller?.dropId) {
    visitedDropIds.add(options.caller.dropId);
  }

  return {
    allowedNetworkHosts,
    toTrustedEmbedUrl: createTrustedEmbedResolver(allowedNetworkHosts),
    caller: options.caller ?? {},
    maxDepth: Math.max(1, options.maxDepth ?? 4),
    visitedDropIds,
    resolveDrop: options.resolveDrop,
  };
};

const escapeRawIframeSyntax = (value: string): string => {
  // Only nullplug-generated embeds should survive to the markdown renderer as iframes.
  return value
    .replace(/<\s*iframe\b/gi, "&lt;iframe")
    .replace(/<\s*\/\s*iframe\s*>/gi, "&lt;/iframe&gt;");
};

const toRenderableDiff = (
  block: PluginBlock,
  patch: RenderablePatch | null,
): RenderableDiff | null => {
  if (!patch) {
    return null;
  }

  if (
    typeof (patch as RenderableDiff).start === "number" &&
    typeof (patch as RenderableDiff).end === "number"
  ) {
    const diff = patch as RenderableDiff;
    return {
      start: diff.start,
      end: diff.end,
      text: diff.text,
    };
  }

  return {
    start: block.start,
    end: block.end,
    text: patch.text,
  };
};

export const applyRenderableDiffs = (
  source: string,
  diffs: readonly RenderableDiff[],
): string => {
  if (!diffs.length) {
    return source;
  }

  const ordered = [...diffs]
    .filter((diff) => typeof diff.text === "string")
    .sort((left, right) => right.start - left.start);

  let output = source;
  let lastStart = Number.POSITIVE_INFINITY;

  ordered.forEach((diff) => {
    const start = Math.max(0, Math.min(diff.start, output.length));
    const end = Math.max(start, Math.min(diff.end, output.length));

    if (end > lastStart) {
      // Overlapping patches indicate competing handlers; keep the earlier replacement and drop the overlap.
      return;
    }

    output = output.slice(0, start) + diff.text + output.slice(end);
    lastStart = start;
  });

  return output;
};

const buildChunkStatus = (
  processedBlocks: number,
  totalBlocks: number,
): RenderChunkStatus => ({
  processedBlocks,
  totalBlocks,
  progress: totalBlocks === 0 ? 1 : processedBlocks / totalBlocks,
});

const yieldToMainThread = async () => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
};

const guardCancellation = (shouldCancel?: () => boolean) => {
  if (shouldCancel?.()) {
    throw new RenderCancelledError();
  }
};

export const renderMarkdownWithNullplugState = async (
  source: string,
  options: RenderPipelineOptions = {},
): Promise<RenderPipelineResult> => {
  const allowedUrls =
    options.runtimePolicy?.network?.allowedHosts ??
    options.allowedUrls ??
    DEFAULT_NETWORK_ALLOWLIST;
  const chunkSize = Math.max(1, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const flushIntervalMs = Math.max(
    10,
    options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
  );

  const escapedSource = escapeRawIframeSyntax(source);
  const blocks = parseNullplugBlocks(escapedSource)
    .map((block) => {
      const handler = resolveNullplug(block.id);
      if (!handler) {
        return null;
      }

      return {
        block,
        handler,
      };
    })
    .filter((entry): entry is ResolvedPluginBlock => entry !== null);

  if (!blocks.length) {
    const status = buildChunkStatus(0, 0);
    options.onFlush?.(escapedSource, status);
    return {
      markdown: escapedSource,
      uiPrimitives: [],
      uiState: {},
      mutations: [],
      yields: [],
      diagnostics: [],
      status,
    };
  }

  const context = createNullplugContext({
    allowedUrls,
    caller: options.caller,
    maxDepth: options.maxDepth,
    resolveDrop: options.resolveDrop,
    visitedDropIds: options.visitedDropIds,
  });
  const diffs: RenderableDiff[] = [];
  const uiPrimitives: NullplugUiPrimitive[] = [];
  const uiState: Record<string, JsonValue> = {};
  const mutations: NullplugMutation[] = [];
  const yields: NullplugYield[] = [];
  const diagnostics: NullplugDiagnostic[] = [];
  let lastFlushAt = Date.now();
  let status = buildChunkStatus(0, blocks.length);

  for (let index = 0; index < blocks.length; index += 1) {
    guardCancellation(options.shouldCancel);

    const { block, handler } = blocks[index];

    const runtimeResult = normalizeNullplugRuntimeReturn(
      await handler(context, block.content, block),
      block,
      { policy: options.runtimePolicy, pluginId: block.id },
    );
    if (runtimeResult) {
      uiPrimitives.push(...(runtimeResult.result.uiPrimitives ?? []));
      Object.assign(uiState, runtimeResult.result.uiState ?? {});
      mutations.push(...(runtimeResult.result.mutations ?? []));
      yields.push(...(runtimeResult.result.yields ?? []));
      diagnostics.push(...runtimeResult.diagnostics);
    }
    const diff = toRenderableDiff(block, runtimeResult?.patch ?? null);
    if (diff) {
      diffs.push(diff);
    }

    const processedBlocks = index + 1;
    const shouldFlushChunk = processedBlocks % chunkSize === 0;
    const shouldFlushByTime = Date.now() - lastFlushAt >= flushIntervalMs;

    if (shouldFlushChunk || shouldFlushByTime) {
      // Flush against the original escaped source each time so patch application stays deterministic.
      const buffered = applyRenderableDiffs(escapedSource, diffs);
      status = buildChunkStatus(processedBlocks, blocks.length);
      options.onFlush?.(buffered, status);
      lastFlushAt = Date.now();
      await yieldToMainThread();
    }
  }

  guardCancellation(options.shouldCancel);
  const rendered = applyRenderableDiffs(escapedSource, diffs);
  status = buildChunkStatus(blocks.length, blocks.length);
  options.onFlush?.(rendered, status);
  return {
    markdown: rendered,
    uiPrimitives,
    uiState,
    mutations,
    yields,
    diagnostics,
    status,
  };
};

export const renderMarkdownWithNullplug = async (
  source: string,
  options: RenderPipelineOptions = {},
): Promise<string> => {
  const result = await renderMarkdownWithNullplugState(source, options);
  return result.markdown;
};

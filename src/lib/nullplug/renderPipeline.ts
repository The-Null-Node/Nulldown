import {
  DEFAULT_IFRAME_ALLOWLIST,
  normalizeIframeAllowlist,
} from "../iframeAllowlist";
import { parseNullplugBlocks } from "./parser";
import { resolveNullplug } from "./registry";
import type {
  NullplugContext,
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
  onFlush?: (renderedMarkdown: string, status: RenderChunkStatus) => void;
  shouldCancel?: () => boolean;
}

export class RenderCancelledError extends Error {
  constructor() {
    super("Render cancelled");
    this.name = "RenderCancelledError";
  }
}

const DEFAULT_CHUNK_SIZE = 6;
const DEFAULT_FLUSH_INTERVAL_MS = 24;

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

const createNullplugContext = (allowedUrls: readonly string[]): NullplugContext => {
  const allowedEmbedHosts = new Set(normalizeIframeAllowlist(allowedUrls));

  return {
    allowedEmbedHosts,
    toTrustedEmbedUrl: createTrustedEmbedResolver(allowedEmbedHosts),
  };
};

const escapeRawIframeSyntax = (value: string): string => {
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

export const renderMarkdownWithNullplug = async (
  source: string,
  options: RenderPipelineOptions = {},
): Promise<string> => {
  const allowedUrls = options.allowedUrls ?? DEFAULT_IFRAME_ALLOWLIST;
  const chunkSize = Math.max(1, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const flushIntervalMs = Math.max(
    10,
    options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
  );

  const escapedSource = escapeRawIframeSyntax(source);
  const blocks = parseNullplugBlocks(escapedSource);

  if (!blocks.length) {
    options.onFlush?.(escapedSource, buildChunkStatus(0, 0));
    return escapedSource;
  }

  const context = createNullplugContext(allowedUrls);
  const diffs: RenderableDiff[] = [];
  let lastFlushAt = Date.now();

  for (let index = 0; index < blocks.length; index += 1) {
    guardCancellation(options.shouldCancel);

    const block = blocks[index];
    const handler = resolveNullplug(block.id);

    if (handler) {
      const patch = await handler(context, block.content, block);
      const diff = toRenderableDiff(block, patch);
      if (diff) {
        diffs.push(diff);
      }
    }

    const processedBlocks = index + 1;
    const shouldFlushChunk = processedBlocks % chunkSize === 0;
    const shouldFlushByTime = Date.now() - lastFlushAt >= flushIntervalMs;

    if (shouldFlushChunk || shouldFlushByTime) {
      const buffered = applyRenderableDiffs(escapedSource, diffs);
      options.onFlush?.(
        buffered,
        buildChunkStatus(processedBlocks, blocks.length),
      );
      lastFlushAt = Date.now();
      await yieldToMainThread();
    }
  }

  guardCancellation(options.shouldCancel);
  const rendered = applyRenderableDiffs(escapedSource, diffs);
  options.onFlush?.(rendered, buildChunkStatus(blocks.length, blocks.length));
  return rendered;
};

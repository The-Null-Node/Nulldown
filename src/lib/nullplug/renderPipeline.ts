/*
This pipeline resolves nullplug fenced blocks before markdown rendering. It is also a
security boundary: raw iframe syntax is neutralized first, plugin handlers only receive
trusted embed helpers, and partial renders are cancellable so stale async work does not
flash outdated preview output.
*/

import { DEFAULT_NETWORK_ALLOWLIST } from "../networkAllowlist";
import type { DropRuntimeNullplugCallProvenance } from "../../../shared/drop/runtime";
import type { RootRuntimePolicy } from "../../../shared/nullplug/policy";
import type {
  JsonValue,
  NullplugDiagnostic,
  NullplugMutation,
  NullplugYield,
} from "../../../shared/nullplug/types";
import type { VoidNullplugRuntime } from "../../../shared/nullplug/runtime";
import type { NullplugUiPrimitive } from "../../../shared/nullplug/ui";
import { discoverRenderInvocations } from "./renderDiscovery";
import { invokeRenderBlock } from "./renderInvocation";
import { mergeRenderInvocationUiState } from "./renderResult";
import {
  createRenderNullplugContext,
  escapeRawIframeSyntax,
} from "./renderSecurity";
import type { NullplugCaller, NullplugContext, RenderableDiff } from "./types";
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
  nullplugRuntime?: VoidNullplugRuntime;
  providerId?: string;
  providerBaseUrl?: string;
  capabilities?: readonly string[];
  resolveDrop?: NullplugContext["resolveDrop"];
  visitedDropIds?: Iterable<string>;
  onFlush?: (renderedMarkdown: string, status: RenderChunkStatus) => void;
  shouldCancel?: () => boolean;
}

export interface RenderPipelineResult {
  markdown: string;
  nullplugCalls: DropRuntimeNullplugCallProvenance[];
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
  const blocks = await discoverRenderInvocations(source, escapedSource, options);

  if (!blocks.length) {
    const status = buildChunkStatus(0, 0);
    options.onFlush?.(escapedSource, status);
    return {
      markdown: escapedSource,
      nullplugCalls: [],
      uiPrimitives: [],
      uiState: {},
      mutations: [],
      yields: [],
      diagnostics: [],
      status,
    };
  }

  const context = createRenderNullplugContext({
    allowedUrls,
    caller: options.caller,
    maxDepth: options.maxDepth,
    resolveDrop: options.resolveDrop,
    visitedDropIds: options.visitedDropIds,
  });
  const diffs: RenderableDiff[] = [];
  const nullplugCalls: DropRuntimeNullplugCallProvenance[] = [];
  const uiPrimitives: NullplugUiPrimitive[] = [];
  const uiState: Record<string, JsonValue> = {};
  const mutations: NullplugMutation[] = [];
  const yields: NullplugYield[] = [];
  const diagnostics: NullplugDiagnostic[] = [];
  let lastFlushAt = Date.now();
  let status = buildChunkStatus(0, blocks.length);

  for (let index = 0; index < blocks.length; index += 1) {
    guardCancellation(options.shouldCancel);
    const invocation = await invokeRenderBlock(
      blocks[index],
      index,
      context,
      options,
    );
    nullplugCalls.push(invocation.call);
    if (invocation.diff) diffs.push(invocation.diff);
    uiPrimitives.push(...invocation.uiPrimitives);
    mergeRenderInvocationUiState(
      uiState,
      invocation.uiState,
      invocation.call.callIds,
    );
    mutations.push(...invocation.mutations);
    yields.push(...invocation.yields);
    diagnostics.push(...invocation.diagnostics);

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
    nullplugCalls,
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

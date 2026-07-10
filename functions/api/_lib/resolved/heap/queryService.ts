import {
  readBranchContent,
  readBranchEventsBySeqRange,
} from "../../branches/content/replay";
import {
  apiHttpErrorResponse,
  isApiHttpError,
  jsonErrorResponse,
  jsonResponse,
} from "../../core/http/responses";
import {
  RESOLVED_DOCUMENT_RESOLVER_ID,
  RESOLVED_RUNTIME_REFS_RESOLVER_ID,
} from "../../../../../shared/drop/resolved/constants";
import type { ResolvedDocumentNodeQueryResult } from "../../../../../shared/drop/resolved/types";
import { hashBranchSnapshotSource } from "../../../../../shared/drop/resolved/hash";
import {
  changedRangesFromDropDiffEvents,
  queryResolvedDocumentNodes,
} from "../../../../../shared/drop/resolved/query/document";
import { queryResolvedRuntimeNodes } from "../../../../../shared/drop/resolved/query/runtime";
import { resolveResolvedBranchTarget } from "./context";
import { ensureResolvedHeapProjection } from "./projector";
import { createResolvedHeapRepository } from "./repository";
import {
  parseBoolean,
  parseDocumentKinds,
  parseOptionalSeq,
  parsePositiveInteger,
  parseRuntimeKinds,
} from "./request";
import type {
  ResolvedHeapEnv,
  ResolvedHeapParams,
  ResolvedHeapQueryOptions,
  ResolvedHeapQueryRepairTarget,
} from "./types";

const RESOLVED_DOCUMENT_SNAPSHOTTER_ID = "nulledit.resolved-document";
const defaultCompactTextLimit = 240;
const maxCompactTextLimit = 600;

const compactText = (value: string, limit: number): { text: string; truncated: boolean } => {
  if (value.length <= limit) {
    return { text: value, truncated: false };
  }

  return {
    text: `${value.slice(0, Math.max(0, limit - 3)).trimEnd()}...`,
    truncated: true,
  };
};

const compactTextLimitFromRequest = (url: URL): number => {
  const maxTokens = parsePositiveInteger(url.searchParams.get("maxTokens"), 0);
  if (maxTokens > 0) {
    return Math.min(maxCompactTextLimit, Math.max(80, maxTokens * 4));
  }

  return parseBoolean(url.searchParams.get("preview")) === false
    ? maxCompactTextLimit
    : defaultCompactTextLimit;
};

const compactResolvedDocumentItems = (
  nodes: readonly ResolvedDocumentNodeQueryResult[],
  url: URL,
): { items: unknown[]; truncated: boolean } => {
  const textLimit = compactTextLimitFromRequest(url);
  let truncated = false;
  const items = nodes.map((entry) => {
    const text = compactText(entry.node.text, textLimit);
    truncated ||= text.truncated;

    return {
      id: entry.node.id,
      kind: entry.node.kind,
      score: entry.score,
      text: text.text,
      sourceRange: entry.node.sourceRange,
      headingPath: entry.node.headingPath,
    };
  });

  return { items, truncated };
};

const queryResolvedHeapUnsafe = async (
  env: ResolvedHeapEnv,
  params: ResolvedHeapParams,
  request: Request,
  options?: ResolvedHeapQueryOptions,
): Promise<Response> => {
  const target = await resolveResolvedBranchTarget(env, params);
  if ("error" in target) return target.error;
  const { rootDropId, branchId, branch } = target;

  const url = new URL(request.url);
  const resolverId =
    url.searchParams.get("resolverId") || RESOLVED_DOCUMENT_RESOLVER_ID;
  const snapshotParam = url.searchParams.get("snapshotId") || "latest";
  const snapshotId =
    snapshotParam === "latest"
      ? branch.headSnapshotId
      : Number.parseInt(snapshotParam, 10);
  if (!Number.isFinite(snapshotId) || snapshotId < 0) {
    return jsonErrorResponse(400, "validation_failed", "Invalid snapshotId.");
  }

  if (snapshotParam === "latest" && options?.repairBufferedCommits) {
    const repairTarget: ResolvedHeapQueryRepairTarget = {
      rootDropId,
      branchId,
      snapshotId,
      resolverId,
    };
    try {
      await options.repairBufferedCommits(repairTarget);
    } catch (error) {
      try {
        options.onRepairError?.(error, repairTarget);
      } catch {
        // Repair is best-effort; the query path can still materialize from branch content.
      }
    }
  }

  const content = await readBranchContent(
    env.R2_BUCKET,
    rootDropId,
    branchId,
    snapshotId,
    env.DB,
  );
  if (content === null) {
    return jsonErrorResponse(
      404,
      "snapshot_content_not_found",
      "Snapshot content not found.",
    );
  }

  const sourceContentHash = await hashBranchSnapshotSource({
    rootDropId,
    branchId,
    snapshotId,
    content,
  });
  const { state, heapGenerated, stale } = await ensureResolvedHeapProjection(
    env,
    resolverId,
    {
      rootDropId,
      branchId,
      snapshotId,
      headEventSeq: branch.headEventSeq,
      content,
    },
    sourceContentHash,
  );

  if (!state) {
    return jsonErrorResponse(
      404,
      "resolved_heap_not_found",
      "Resolved heap not found.",
    );
  }

  const priorityScoring = await createResolvedHeapRepository({
    sql: env.DB,
  }).readPriorityScoring(rootDropId, branchId, state.resolverId);

  if (state.resolverId === RESOLVED_RUNTIME_REFS_RESOLVER_ID) {
    const nodes = queryResolvedRuntimeNodes(state, {
      q:
        url.searchParams.get("q") || url.searchParams.get("query") || undefined,
      kinds: parseRuntimeKinds(url.searchParams.get("kind")),
      limit: parsePositiveInteger(
        url.searchParams.get("k") || url.searchParams.get("top"),
        10,
      ),
      pluginId: url.searchParams.get("pluginId") || undefined,
      callId: url.searchParams.get("callId") || undefined,
      primitiveId: url.searchParams.get("primitiveId") || undefined,
      priorityByNodeId: priorityScoring.priorityByNodeId,
      heapPriority: priorityScoring.heapPriority,
    });

    return jsonResponse({
      rootDropId,
      branchId,
      snapshotId,
      resolverId: state.resolverId,
      resolverVersion: state.resolverVersion,
      sourceContentHash: state.sourceContentHash,
      stale,
      heapGenerated,
      nodeCount: state.runtimeNodes?.length ?? 0,
      nodes,
    });
  }

  const fromSeq = parseOptionalSeq(url.searchParams.get("fromSeq"));
  const toSeq = parseOptionalSeq(url.searchParams.get("toSeq"));
  const events =
    fromSeq !== null || toSeq !== null
      ? await readBranchEventsBySeqRange(
          env.R2_BUCKET,
          rootDropId,
          branchId,
          fromSeq ?? toSeq ?? 0,
          toSeq ?? fromSeq ?? 0,
          env.DB,
        )
      : [];
  const includeEventMetadata =
    url.searchParams.get("includeEventMetadata") !== "false";
  const eventRefs = changedRangesFromDropDiffEvents(events).map((event) =>
    includeEventMetadata ? event : { ...event, metadata: undefined },
  );
  const nodes = queryResolvedDocumentNodes(state, {
    q: url.searchParams.get("q") || url.searchParams.get("query") || undefined,
    kinds: parseDocumentKinds(url.searchParams.get("kind")),
    limit: parsePositiveInteger(
      url.searchParams.get("k") || url.searchParams.get("top"),
      10,
    ),
    events: eventRefs,
    changedOnly: parseBoolean(url.searchParams.get("changedOnly")),
    includeAncestors: parseBoolean(url.searchParams.get("includeAncestors")),
    priorityByNodeId: priorityScoring.priorityByNodeId,
    priorityByDiffEventId: priorityScoring.priorityByDiffEventId,
    heapPriority: priorityScoring.heapPriority,
  });

  if (url.searchParams.get("snapshotterId") === RESOLVED_DOCUMENT_SNAPSHOTTER_ID) {
    const compact = compactResolvedDocumentItems(nodes, url);
    return jsonResponse({
      rootDropId,
      branchId,
      snapshotId,
      snapshotterId: RESOLVED_DOCUMENT_SNAPSHOTTER_ID,
      resolverId: state.resolverId,
      resolverVersion: state.resolverVersion,
      sourceContentHash: state.sourceContentHash,
      stale,
      heapGenerated,
      nodeCount: state.documentNodes?.length ?? 0,
      items: compact.items,
      truncated: compact.truncated || undefined,
    });
  }

  return jsonResponse({
    rootDropId,
    branchId,
    snapshotId,
    resolverId: state.resolverId,
    resolverVersion: state.resolverVersion,
    sourceContentHash: state.sourceContentHash,
    stale,
    heapGenerated,
    nodeCount: state.documentNodes?.length ?? 0,
    nodes,
  });
};

/** Queries a branch resolved heap, regenerating supported stale heaps on demand. */
export const queryResolvedHeap = async (
  env: ResolvedHeapEnv,
  params: ResolvedHeapParams,
  request: Request,
  options?: ResolvedHeapQueryOptions,
): Promise<Response> => {
  try {
    return await queryResolvedHeapUnsafe(env, params, request, options);
  } catch (error) {
    if (isApiHttpError(error)) {
      return apiHttpErrorResponse(error);
    }

    const message = error instanceof Error ? error.message : String(error);
    return jsonErrorResponse(
      500,
      "resolved_query_failed",
      `Failed to query resolved heap: ${message}`,
    );
  }
};

import type { R2Bucket } from "@cloudflare/workers-types";
import { readBranchContent, readBranchEventsBySeqRange } from "./branchContent";
import { readBranch } from "./branchRepository";
import { sanitizeDiffAuthToken } from "./diffAuth";
import { resolveRemoteDropId } from "./dropId";
import {
  apiHttpErrorResponse,
  isApiHttpError,
  jsonErrorResponse,
  jsonResponse,
  readRequestTextWithLimit,
  resolveParam,
} from "./http";
import { listNullplugRuntimeFacts } from "./nullplugFacts";
import {
  RESOLVED_DOCUMENT_RESOLVER_ID,
  RESOLVED_RUNTIME_REFS_RESOLVER_ID,
  changedRangesFromDropDiffEvents,
  hashBranchSnapshotSource,
  heapifyResolvedDocument,
  heapifyResolvedRuntimeRefs,
  queryResolvedDocumentNodes,
  queryResolvedRuntimeNodes,
  readResolvedNulldownState,
  writeResolvedNulldownState,
  type ResolvedDocumentNodeKind,
  type ResolvedRuntimeNodeKind,
} from "../../../shared/drop/resolved";
import {
  isNullplugUiPrimitive,
  isNullplugUiResponseFact,
  isNullplugUiStatePatchFact,
  isNullplugUiStateSnapshot,
  type NullplugUiPrimitive,
  type NullplugUiResponseFact,
  type NullplugUiStatePatchFact,
  type NullplugUiStateSnapshot,
} from "../../../shared/nullplug/ui";

/** Environment required by resolved heap route services. */
export interface ResolvedHeapEnv {
  R2_BUCKET: R2Bucket;
}

/** Route parameters for branch resolved heap operations. */
export interface ResolvedHeapParams {
  rootId: string | string[];
  branchId: string | string[];
}

interface ResolvedUpdateRequest {
  resolverId?:
    | typeof RESOLVED_DOCUMENT_RESOLVER_ID
    | typeof RESOLVED_RUNTIME_REFS_RESOLVER_ID
    | "all";
  snapshotId?: number | "latest";
  uiPrimitives?: NullplugUiPrimitive[];
  uiResponseFacts?: NullplugUiResponseFact[];
  uiStatePatchFacts?: NullplugUiStatePatchFact[];
  uiStateSnapshots?: NullplugUiStateSnapshot[];
}

const RESOLVED_UPDATE_BODY_MAX_BYTES = 1_000_000;

const DOCUMENT_NODE_KINDS = new Set<ResolvedDocumentNodeKind>([
  "document.title",
  "section",
  "heading",
  "paragraph",
  "list.item",
  "checklist.item",
  "code.block",
  "nullplug.ref",
  "link.ref",
  "diff.region",
]);

const RUNTIME_NODE_KINDS = new Set<ResolvedRuntimeNodeKind>([
  "nullplug.ref",
  "ui.primitive",
  "ui.state",
  "ui.response",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parsePositiveInteger = (value: string | null, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseOptionalSeq = (value: string | null): number | null => {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const parseBoolean = (value: string | null): boolean =>
  value === "1" || value === "true" || value === "yes";

const parseKinds = (value: string | null): ResolvedDocumentNodeKind[] | undefined => {
  if (!value) return undefined;
  const kinds = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry): entry is ResolvedDocumentNodeKind =>
      DOCUMENT_NODE_KINDS.has(entry as ResolvedDocumentNodeKind),
    );
  return kinds.length ? kinds : undefined;
};

const parseRuntimeKinds = (
  value: string | null,
): ResolvedRuntimeNodeKind[] | undefined => {
  if (!value) return undefined;
  const kinds = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry): entry is ResolvedRuntimeNodeKind =>
      RUNTIME_NODE_KINDS.has(entry as ResolvedRuntimeNodeKind),
    );
  return kinds.length ? kinds : undefined;
};

const parseUpdateBody = (rawBody: string): ResolvedUpdateRequest | null => {
  if (!rawBody.trim()) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  const resolverId = parsed.resolverId;
  if (
    resolverId !== undefined &&
    resolverId !== "all" &&
    resolverId !== RESOLVED_DOCUMENT_RESOLVER_ID &&
    resolverId !== RESOLVED_RUNTIME_REFS_RESOLVER_ID
  ) {
    return null;
  }
  if (
    parsed.snapshotId !== undefined &&
    parsed.snapshotId !== "latest" &&
    !(
      typeof parsed.snapshotId === "number" &&
      Number.isInteger(parsed.snapshotId) &&
      parsed.snapshotId >= 0
    )
  ) {
    return null;
  }
  if (
    parsed.uiPrimitives !== undefined &&
    (!Array.isArray(parsed.uiPrimitives) ||
      !parsed.uiPrimitives.every(isNullplugUiPrimitive))
  ) {
    return null;
  }
  if (
    parsed.uiResponseFacts !== undefined &&
    (!Array.isArray(parsed.uiResponseFacts) ||
      !parsed.uiResponseFacts.every(isNullplugUiResponseFact))
  ) {
    return null;
  }
  if (
    parsed.uiStatePatchFacts !== undefined &&
    (!Array.isArray(parsed.uiStatePatchFacts) ||
      !parsed.uiStatePatchFacts.every(isNullplugUiStatePatchFact))
  ) {
    return null;
  }
  if (
    parsed.uiStateSnapshots !== undefined &&
    (!Array.isArray(parsed.uiStateSnapshots) ||
      !parsed.uiStateSnapshots.every(isNullplugUiStateSnapshot))
  ) {
    return null;
  }

  return parsed as ResolvedUpdateRequest;
};

const resolveBranchTarget = async (
  env: ResolvedHeapEnv,
  params: ResolvedHeapParams,
) => {
  if (!env.R2_BUCKET) {
    return { error: new Response("R2 bucket binding is required.", { status: 500 }) };
  }

  const rootDropId = await resolveRemoteDropId(
    env.R2_BUCKET,
    resolveParam(params.rootId),
  );
  const branchId = sanitizeDiffAuthToken(resolveParam(params.branchId));
  if (!rootDropId || !branchId) {
    return {
      error: jsonErrorResponse(
        400,
        "validation_failed",
        "Root drop ID and branch ID are required.",
      ),
    };
  }

  const branch = await readBranch(env.R2_BUCKET, rootDropId, branchId);
  if (!branch) {
    return {
      error: jsonErrorResponse(404, "branch_not_found", "Branch not found."),
    };
  }

  return { rootDropId, branchId, branch };
};

/** Queries a branch resolved heap, regenerating supported stale heaps on demand. */
export const queryResolvedHeap = async (
  env: ResolvedHeapEnv,
  params: ResolvedHeapParams,
  request: Request,
): Promise<Response> => {
  const target = await resolveBranchTarget(env, params);
  if (target.error) return target.error;
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

  const content = await readBranchContent(env.R2_BUCKET, rootDropId, branchId, snapshotId);
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
  let state = await readResolvedNulldownState(
    env.R2_BUCKET,
    rootDropId,
    branchId,
    resolverId,
    snapshotId,
  );
  let heapGenerated = false;
  let stale = Boolean(state && state.sourceContentHash !== sourceContentHash);

  if ((!state || stale) && resolverId === RESOLVED_DOCUMENT_RESOLVER_ID) {
    state = await heapifyResolvedDocument({
      rootDropId,
      branchId,
      snapshotId,
      sourceSeqRange:
        branch.headEventSeq === undefined
          ? undefined
          : { from: 0, to: branch.headEventSeq },
      content,
    });
    await writeResolvedNulldownState(env.R2_BUCKET, state);
    heapGenerated = true;
    stale = false;
  }

  if ((!state || stale) && resolverId === RESOLVED_RUNTIME_REFS_RESOLVER_ID) {
    const runtimeFacts = await listNullplugRuntimeFacts(
      env.R2_BUCKET,
      rootDropId,
      branchId,
    );
    state = await heapifyResolvedRuntimeRefs({
      rootDropId,
      branchId,
      snapshotId,
      sourceSeqRange:
        branch.headEventSeq === undefined
          ? undefined
          : { from: 0, to: branch.headEventSeq },
      content,
      uiResponseFacts: runtimeFacts.uiResponseFacts,
      uiStatePatchFacts: runtimeFacts.uiStatePatchFacts,
      uiStateSnapshots: runtimeFacts.uiStateSnapshots,
    });
    await writeResolvedNulldownState(env.R2_BUCKET, state);
    heapGenerated = true;
    stale = false;
  }

  if (!state) {
    return jsonErrorResponse(
      404,
      "resolved_heap_not_found",
      "Resolved heap not found.",
    );
  }

  if (state.resolverId === RESOLVED_RUNTIME_REFS_RESOLVER_ID) {
    const nodes = queryResolvedRuntimeNodes(state, {
      q: url.searchParams.get("q") || url.searchParams.get("query") || undefined,
      kinds: parseRuntimeKinds(url.searchParams.get("kind")),
      limit: parsePositiveInteger(
        url.searchParams.get("k") || url.searchParams.get("top"),
        10,
      ),
      pluginId: url.searchParams.get("pluginId") || undefined,
      callId: url.searchParams.get("callId") || undefined,
      primitiveId: url.searchParams.get("primitiveId") || undefined,
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
        )
      : [];
  const includeEventMetadata =
    url.searchParams.get("includeEventMetadata") !== "false";
  const eventRefs = changedRangesFromDropDiffEvents(events).map((event) =>
    includeEventMetadata ? event : { ...event, metadata: undefined },
  );
  const nodes = queryResolvedDocumentNodes(state, {
    q: url.searchParams.get("q") || url.searchParams.get("query") || undefined,
    kinds: parseKinds(url.searchParams.get("kind")),
    limit: parsePositiveInteger(
      url.searchParams.get("k") || url.searchParams.get("top"),
      10,
    ),
    events: eventRefs,
    changedOnly: parseBoolean(url.searchParams.get("changedOnly")),
    includeAncestors: parseBoolean(url.searchParams.get("includeAncestors")),
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
    nodeCount: state.documentNodes?.length ?? 0,
    nodes,
  });
};

/** Rebuilds and stores one or more resolved heaps for a branch snapshot. */
export const updateResolvedHeap = async (
  env: ResolvedHeapEnv,
  params: ResolvedHeapParams,
  request: Request,
): Promise<Response> => {
  try {
    const target = await resolveBranchTarget(env, params);
    if (target.error) return target.error;
    const { rootDropId, branchId, branch } = target;

    const rawBody = await readRequestTextWithLimit(
      request,
      RESOLVED_UPDATE_BODY_MAX_BYTES,
    );
    const parsed = parseUpdateBody(rawBody);
    if (!parsed) {
      return jsonErrorResponse(
        400,
        "validation_failed",
        "Invalid resolved heap update payload.",
      );
    }

    const snapshotId =
      parsed.snapshotId === undefined || parsed.snapshotId === "latest"
        ? branch.headSnapshotId
        : parsed.snapshotId;
    const content = await readBranchContent(
      env.R2_BUCKET,
      rootDropId,
      branchId,
      snapshotId,
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
    const resolverId = parsed.resolverId ?? "all";
    const updated: Array<{
      resolverId: string;
      key: string;
      nodeCount: number;
      sourceContentHash: string;
    }> = [];

    if (resolverId === "all" || resolverId === RESOLVED_DOCUMENT_RESOLVER_ID) {
      const state = await heapifyResolvedDocument({
        rootDropId,
        branchId,
        snapshotId,
        sourceSeqRange:
          branch.headEventSeq === undefined
            ? undefined
            : { from: 0, to: branch.headEventSeq },
        content,
      });
      const key = await writeResolvedNulldownState(env.R2_BUCKET, state);
      updated.push({
        resolverId: state.resolverId,
        key,
        nodeCount: state.documentNodes?.length ?? 0,
        sourceContentHash: state.sourceContentHash,
      });
    }

    if (resolverId === "all" || resolverId === RESOLVED_RUNTIME_REFS_RESOLVER_ID) {
      const runtimeFacts = await listNullplugRuntimeFacts(
        env.R2_BUCKET,
        rootDropId,
        branchId,
      );
      const state = await heapifyResolvedRuntimeRefs({
        rootDropId,
        branchId,
        snapshotId,
        sourceSeqRange:
          branch.headEventSeq === undefined
            ? undefined
            : { from: 0, to: branch.headEventSeq },
        content,
        uiPrimitives: parsed.uiPrimitives,
        uiResponseFacts: [
          ...runtimeFacts.uiResponseFacts,
          ...(parsed.uiResponseFacts ?? []),
        ],
        uiStatePatchFacts: [
          ...runtimeFacts.uiStatePatchFacts,
          ...(parsed.uiStatePatchFacts ?? []),
        ],
        uiStateSnapshots: [
          ...runtimeFacts.uiStateSnapshots,
          ...(parsed.uiStateSnapshots ?? []),
        ],
      });
      const key = await writeResolvedNulldownState(env.R2_BUCKET, state);
      updated.push({
        resolverId: state.resolverId,
        key,
        nodeCount: state.runtimeNodes?.length ?? 0,
        sourceContentHash: state.sourceContentHash,
      });
    }

    return jsonResponse({
      rootDropId,
      branchId,
      snapshotId,
      sourceContentHash,
      updated,
    });
  } catch (error) {
    if (isApiHttpError(error)) {
      return apiHttpErrorResponse(error);
    }
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Failed to update resolved heap: ${message}`, {
      status: 500,
    });
  }
};

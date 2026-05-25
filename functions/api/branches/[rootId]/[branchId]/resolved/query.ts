import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import {
  readBranch,
  readBranchContent,
  readBranchEventsBySeqRange,
} from "../../../../_lib/branchState";
import { sanitizeDiffAuthToken } from "../../../../_lib/diffAuth";
import { resolveRemoteDropId } from "../../../../_lib/dropId";
import { jsonErrorResponse, jsonResponse } from "../../../../_lib/http";
import {
  RESOLVED_DOCUMENT_RESOLVER_ID,
  RESOLVED_DOCUMENT_RESOLVER_VERSION,
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
} from "../../../../../../shared/drop/resolved";
import { listNullplugRuntimeFacts } from "../../../../_lib/nullplugFacts";

interface Env {
  R2_BUCKET: R2Bucket;
}

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

const resolveParam = (value: string | string[] | undefined): string =>
  typeof value === "string" ? value : Array.isArray(value) ? value[0] : "";

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

export const onRequestGet: PagesFunction<Env, "rootId" | "branchId"> = async ({
  env,
  params,
  request,
}) => {
  if (!env.R2_BUCKET) {
    return new Response("R2 bucket binding is required.", { status: 500 });
  }

  const rootDropId = await resolveRemoteDropId(
    env.R2_BUCKET,
    resolveParam(params.rootId),
  );
  const branchId = sanitizeDiffAuthToken(resolveParam(params.branchId));
  if (!rootDropId || !branchId) {
    return jsonErrorResponse(
      400,
      "validation_failed",
      "Root drop ID and branch ID are required.",
    );
  }

  const branch = await readBranch(env.R2_BUCKET, rootDropId, branchId);
  if (!branch) {
    return jsonErrorResponse(404, "branch_not_found", "Branch not found.");
  }

  const url = new URL(request.url);
  const resolverId = url.searchParams.get("resolverId") || RESOLVED_DOCUMENT_RESOLVER_ID;
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
    return jsonErrorResponse(404, "snapshot_content_not_found", "Snapshot content not found.");
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

  if (
    (!state || stale) &&
    resolverId === RESOLVED_DOCUMENT_RESOLVER_ID
  ) {
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

  if (
    (!state || stale) &&
    resolverId === RESOLVED_RUNTIME_REFS_RESOLVER_ID
  ) {
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
    return jsonErrorResponse(404, "resolved_heap_not_found", "Resolved heap not found.");
  }

  if (state.resolverId === RESOLVED_RUNTIME_REFS_RESOLVER_ID) {
    const nodes = queryResolvedRuntimeNodes(state, {
      q: url.searchParams.get("q") || url.searchParams.get("query") || undefined,
      kinds: parseRuntimeKinds(url.searchParams.get("kind")),
      limit: parsePositiveInteger(url.searchParams.get("k") || url.searchParams.get("top"), 10),
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
  const includeEventMetadata = url.searchParams.get("includeEventMetadata") !== "false";
  const eventRefs = changedRangesFromDropDiffEvents(events).map((event) =>
    includeEventMetadata ? event : { ...event, metadata: undefined },
  );
  const nodes = queryResolvedDocumentNodes(state, {
    q: url.searchParams.get("q") || url.searchParams.get("query") || undefined,
    kinds: parseKinds(url.searchParams.get("kind")),
    limit: parsePositiveInteger(url.searchParams.get("k") || url.searchParams.get("top"), 10),
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

export const onRequest: PagesFunction<Env, "rootId" | "branchId"> = async (context) => {
  if (context.request.method === "GET") {
    return onRequestGet(context);
  }

  return jsonErrorResponse(405, "method_not_allowed", "Method Not Allowed");
};

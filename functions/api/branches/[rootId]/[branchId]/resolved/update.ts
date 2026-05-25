import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import { readBranch, readBranchContent } from "../../../../_lib/branchState";
import { sanitizeDiffAuthToken } from "../../../../_lib/diffAuth";
import { resolveRemoteDropId } from "../../../../_lib/dropId";
import {
  apiHttpErrorResponse,
  isApiHttpError,
  jsonErrorResponse,
  jsonResponse,
  methodNotAllowedResponse,
  readRequestTextWithLimit,
} from "../../../../_lib/http";
import { listNullplugRuntimeFacts } from "../../../../_lib/nullplugFacts";
import {
  RESOLVED_DOCUMENT_RESOLVER_ID,
  RESOLVED_RUNTIME_REFS_RESOLVER_ID,
  hashBranchSnapshotSource,
  heapifyResolvedDocument,
  heapifyResolvedRuntimeRefs,
  writeResolvedNulldownState,
} from "../../../../../../shared/drop/resolved";
import {
  isNullplugUiPrimitive,
  isNullplugUiResponseFact,
  isNullplugUiStatePatchFact,
  isNullplugUiStateSnapshot,
  type NullplugUiPrimitive,
  type NullplugUiResponseFact,
  type NullplugUiStatePatchFact,
  type NullplugUiStateSnapshot,
} from "../../../../../../shared/nullplug/ui";

interface Env {
  R2_BUCKET: R2Bucket;
}

interface ResolvedUpdateRequest {
  resolverId?: typeof RESOLVED_DOCUMENT_RESOLVER_ID | typeof RESOLVED_RUNTIME_REFS_RESOLVER_ID | "all";
  snapshotId?: number | "latest";
  uiPrimitives?: NullplugUiPrimitive[];
  uiResponseFacts?: NullplugUiResponseFact[];
  uiStatePatchFacts?: NullplugUiStatePatchFact[];
  uiStateSnapshots?: NullplugUiStateSnapshot[];
}

const RESOLVED_UPDATE_BODY_MAX_BYTES = 1_000_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseBody = (rawBody: string): ResolvedUpdateRequest | null => {
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
    !(typeof parsed.snapshotId === "number" && Number.isInteger(parsed.snapshotId) && parsed.snapshotId >= 0)
  ) {
    return null;
  }
  if (
    parsed.uiPrimitives !== undefined &&
    (!Array.isArray(parsed.uiPrimitives) || !parsed.uiPrimitives.every(isNullplugUiPrimitive))
  ) {
    return null;
  }
  if (
    parsed.uiResponseFacts !== undefined &&
    (!Array.isArray(parsed.uiResponseFacts) || !parsed.uiResponseFacts.every(isNullplugUiResponseFact))
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

const resolveParam = (value: string | string[] | undefined): string =>
  typeof value === "string" ? value : Array.isArray(value) ? value[0] : "";

export const onRequestPost: PagesFunction<Env, "rootId" | "branchId"> = async ({
  env,
  params,
  request,
}) => {
  try {
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

    const rawBody = await readRequestTextWithLimit(
      request,
      RESOLVED_UPDATE_BODY_MAX_BYTES,
    );
    const parsed = parseBody(rawBody);
    if (!parsed) {
      return jsonErrorResponse(
        400,
        "validation_failed",
        "Invalid resolved heap update payload.",
      );
    }

    const snapshotId = parsed.snapshotId === undefined || parsed.snapshotId === "latest"
      ? branch.headSnapshotId
      : parsed.snapshotId;
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
    return new Response(`Failed to update resolved heap: ${message}`, { status: 500 });
  }
};

export const onRequest: PagesFunction<Env, "rootId" | "branchId"> = async (context) => {
  if (context.request.method === "POST") {
    return onRequestPost(context);
  }

  return methodNotAllowedResponse();
};

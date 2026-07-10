import { readBranchContent } from "../../branches/content/replay";
import {
  apiHttpErrorResponse,
  isApiHttpError,
  jsonErrorResponse,
  jsonResponse,
  readRequestTextWithLimit,
} from "../../core/http/responses";
import {
  RESOLVED_DOCUMENT_RESOLVER_ID,
  RESOLVED_RUNTIME_REFS_RESOLVER_ID,
} from "../../../../../shared/drop/resolved/constants";
import { hashBranchSnapshotSource } from "../../../../../shared/drop/resolved/hash";
import { resolveResolvedBranchTarget } from "./context";
import { projectResolvedHeap } from "./projector";
import { parseResolvedUpdateBody } from "./request";
import type { ResolvedHeapEnv, ResolvedHeapParams } from "./types";

const RESOLVED_UPDATE_BODY_MAX_BYTES = 1_000_000;

/** Rebuilds and stores one or more resolved heaps for a branch snapshot. */
export const updateResolvedHeap = async (
  env: ResolvedHeapEnv,
  params: ResolvedHeapParams,
  request: Request,
): Promise<Response> => {
  try {
    const target = await resolveResolvedBranchTarget(env, params);
    if ("error" in target) return target.error;
    const { rootDropId, branchId, branch } = target;

    const rawBody = await readRequestTextWithLimit(
      request,
      RESOLVED_UPDATE_BODY_MAX_BYTES,
    );
    const parsed = parseResolvedUpdateBody(rawBody);
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
    const resolverId = parsed.resolverId ?? "all";
    const updated: Array<{
      resolverId: string;
      key: string;
      nodeCount: number;
      sourceContentHash: string;
    }> = [];
    const projectionSource = {
      rootDropId,
      branchId,
      snapshotId,
      headEventSeq: branch.headEventSeq,
      content,
    };

    if (resolverId === "all" || resolverId === RESOLVED_DOCUMENT_RESOLVER_ID) {
      const { state, key } = await projectResolvedHeap(
        env,
        RESOLVED_DOCUMENT_RESOLVER_ID,
        projectionSource,
      );
      updated.push({
        resolverId: state.resolverId,
        key,
        nodeCount: state.documentNodes?.length ?? 0,
        sourceContentHash: state.sourceContentHash,
      });
    }

    if (
      resolverId === "all" ||
      resolverId === RESOLVED_RUNTIME_REFS_RESOLVER_ID
    ) {
      const { state, key } = await projectResolvedHeap(
        env,
        RESOLVED_RUNTIME_REFS_RESOLVER_ID,
        projectionSource,
        parsed,
      );
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

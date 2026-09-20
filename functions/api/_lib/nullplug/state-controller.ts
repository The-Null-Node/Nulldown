/*
 `/api/nullplug/state` stores nullplug-owned UI state facts. These records are
 durable inputs for resolved runtime heaps; they do not directly mutate branch content.
*/

import {
  isNullplugUiStatePatchFact,
  isNullplugUiStateSnapshot,
  type NullplugUiStatePatchFact,
  type NullplugUiStateSnapshot,
} from "../../../../shared/nullplug/ui";
import { putNullplugUiStateFact } from "./facts/repository";
import { createDropIdentityRepository } from "../drops/identity/id";
import { resolveAuthenticatedAccountId } from "../accounts/session/auth";
import { createBranchRepository } from "../branches/storage/repository";
import { readBranchContent } from "../branches/content/replay";
import { createBranchRuntimeFactLogRepository } from "../branches/storage/runtimeFactLogRepository";
import { sanitizeDiffAuthToken } from "../diffs/credentials/repository";
import { updateResolvedHeap } from "../resolved/heap/service";
import { RESOLVED_RUNTIME_REFS_RESOLVER_ID } from "../../../../shared/drop/resolved/constants";
import { hashMarkdownSource } from "../../../../shared/drop/resolved/hash";
import type { ResolvedHeapEnv } from "../resolved/heap/types";
import { createRequestLogger, toLogRef } from "../core/logging/logger";
import {
  jsonErrorResponse,
  jsonResponse,
  methodNotAllowedResponse,
  readRequestTextWithLimit,
} from "../core/http/responses";

type NullplugUiStateFact = NullplugUiStatePatchFact | NullplugUiStateSnapshot;

const NULLPLUG_STATE_BODY_MAX_BYTES = 512_000;

const parseStateFact = (rawBody: string): NullplugUiStateFact | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }

  if (isNullplugUiStatePatchFact(parsed)) return parsed;
  if (isNullplugUiStateSnapshot(parsed)) return parsed;
  return null;
};

const handlePost = async (
  env: ResolvedHeapEnv,
  request: Request,
): Promise<Response> => {
  const logger = createRequestLogger({
    request,
    env,
    route: "/api/nullplug/state",
  });
  logger.logStart();

  try {
    if (!env.R2_BUCKET) {
      logger.logEnd(500, { reason: "bucket_missing" });
      return new Response("R2 bucket binding is required.", { status: 500 });
    }

    const serviceEnv = env;

    const rawBody = await readRequestTextWithLimit(
      request,
      NULLPLUG_STATE_BODY_MAX_BYTES,
    );
    const parsed = parseStateFact(rawBody);
    if (!parsed) {
      logger.logEnd(400, { reason: "invalid_state_fact" });
      return jsonErrorResponse(
        400,
        "validation_failed",
        "Invalid nullplug UI state fact.",
      );
    }

    const accountId = await resolveAuthenticatedAccountId(request, serviceEnv);
    if (!accountId) {
      logger.logEnd(401, { reason: "unauthenticated_account" });
      return jsonErrorResponse(
        401,
        "account_required",
        "Authenticated account session is required.",
      );
    }

    const branchId = parsed.source.branchId
      ? sanitizeDiffAuthToken(parsed.source.branchId)
      : null;
    if (!branchId) {
      logger.logEnd(400, { reason: "branch_required" });
      return jsonErrorResponse(
        400,
        "branch_required",
        "Nullplug UI state must target a branch.",
      );
    }

    const dropIdentityRepository = createDropIdentityRepository({
      blobs: serviceEnv.R2_BUCKET,
      sql: serviceEnv.DB,
    });
    const canonicalRootDropId =
      await dropIdentityRepository.resolveRemoteDropId(
        parsed.source.rootDropId,
        logger,
      );
    if (
      !canonicalRootDropId ||
      !(await serviceEnv.R2_BUCKET.get(canonicalRootDropId))
    ) {
      logger.logEnd(404, {
        reason: "root_drop_not_found",
        rootDropRef: toLogRef(parsed.source.rootDropId),
      });
      return jsonErrorResponse(
        404,
        "root_drop_not_found",
        "Root drop not found.",
      );
    }

    const branchRepository = createBranchRepository({
      blobs: serviceEnv.R2_BUCKET,
      sql: serviceEnv.DB,
    });
    const branch = await branchRepository.readBranch(
      canonicalRootDropId,
      branchId,
    );
    if (!branch) {
      logger.logEnd(404, { reason: "branch_not_found" });
      return jsonErrorResponse(404, "branch_not_found", "Branch not found.");
    }
    if (
      accountId !== branch.ownerAccountId &&
      accountId !== branch.writerAccountId
    ) {
      logger.logEnd(403, { reason: "forbidden" });
      return jsonErrorResponse(
        403,
        "forbidden",
        "You are not allowed to store state for this branch.",
      );
    }
    if (branch.status !== "active") {
      logger.logEnd(409, { reason: "branch_not_active" });
      return jsonErrorResponse(
        409,
        "branch_not_active",
        "Nullplug state requires an active branch.",
      );
    }
    if (!parsed.source.sourceContentHash) {
      logger.logEnd(400, { reason: "source_hash_required" });
      return jsonErrorResponse(
        400,
        "source_hash_required",
        "Nullplug state must include the rendered source hash.",
      );
    }
    const branchContent = await readBranchContent(
      serviceEnv.R2_BUCKET,
      canonicalRootDropId,
      branchId,
      branch.headSnapshotId,
      serviceEnv.DB,
    );
    if (
      branchContent === null ||
      (await hashMarkdownSource(branchContent)) !==
        parsed.source.sourceContentHash
    ) {
      logger.logEnd(409, { reason: "stale_source" });
      return jsonErrorResponse(
        409,
        "stale_source",
        "The state change was rendered for an older branch revision.",
      );
    }

    const fact: NullplugUiStateFact = {
      ...parsed,
      createdAt: Date.now(),
      source: {
        ...parsed.source,
        rootDropId: canonicalRootDropId,
        branchId,
        snapshotId: branch.headSnapshotId,
      },
      metadata: {
        ...parsed.metadata,
        actorAccountId: accountId,
      },
    };
    const { key, written } = await putNullplugUiStateFact(
      serviceEnv.R2_BUCKET,
      fact,
      serviceEnv.DB,
    );

    const runtimeFact = await createBranchRuntimeFactLogRepository({
      blobs: serviceEnv.R2_BUCKET,
      sql: serviceEnv.DB,
    }).appendBranchRuntimeFact(canonicalRootDropId, branchId, fact);

    const projectionResponse = await updateResolvedHeap(
      serviceEnv,
      { rootId: canonicalRootDropId, branchId },
      new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify({
          resolverId: RESOLVED_RUNTIME_REFS_RESOLVER_ID,
          snapshotId: "latest",
        }),
      }),
    );
    const indexed = projectionResponse.ok;
    if (!indexed) {
      logger.logError(
        "nullplug.state.index_failed",
        new Error(await projectionResponse.text()),
      );
    }

    logger.logEnd(200, {
      rootDropRef: toLogRef(canonicalRootDropId),
      branchRef: toLogRef(fact.source.branchId),
      callId: fact.callId,
      kind: fact.kind,
      appended: runtimeFact.appended,
      indexed,
    });
    return jsonResponse({
      stored: true,
      duplicate: !written,
      indexed,
      key,
      fact,
      runtimeFact,
    });
  } catch (error) {
    logger.logError("nullplug.state.unhandled_error", error);
    logger.logEnd(500, { reason: "unhandled_error" });
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Failed to store nullplug state: ${message}`, {
      status: 500,
    });
  }
};

/** Handles the portable HTTP contract for Nullplug UI state submission. */
export const handleNullplugStateRequest = async (context: {
  request: Request;
  env: ResolvedHeapEnv;
}): Promise<Response> => {
  if (context.request.method === "POST") {
    return handlePost(context.env, context.request);
  }

  return methodNotAllowedResponse();
};

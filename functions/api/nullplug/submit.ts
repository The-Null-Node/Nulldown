/*
 `/api/nullplug/submit` stores atomic UI responses as immutable facts. Proposed diffs
 stay data until a separate policy grant accepts them into branch diffs.
*/

import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import {
  isNullplugUiResponseFact,
  type NullplugUiResponseFact,
} from "../../../shared/nullplug/ui";
import { putNullplugUiResponseFact } from "../_lib/nullplug/facts/repository";
import { createDropIdentityRepository } from "../_lib/drops/identity/id";
import { resolveAuthenticatedAccountId } from "../_lib/accounts/session/auth";
import { createBranchRepository } from "../_lib/branches/storage/repository";
import { readBranchContent } from "../_lib/branches/content/replay";
import { createBranchRuntimeFactLogRepository } from "../_lib/branches/storage/runtimeFactLogRepository";
import { sanitizeDiffAuthToken } from "../_lib/diffs/credentials/repository";
import { updateResolvedHeap } from "../_lib/resolved/heap/service";
import { RESOLVED_RUNTIME_REFS_RESOLVER_ID } from "../../../shared/drop/resolved/constants";
import { hashMarkdownSource } from "../../../shared/drop/resolved/hash";
import {
  createCloudflareBlobStore,
  createCloudflareSqlStore,
} from "../_lib/core/platform/cloudflarePorts";
import type { ResolvedHeapEnv } from "../_lib/resolved/heap/types";
import { createRequestLogger, toLogRef } from "../_lib/core/logging/logger";
import {
  jsonErrorResponse,
  jsonResponse,
  methodNotAllowedResponse,
  readRequestTextWithLimit,
} from "../_lib/core/http/responses";

interface Env {
  R2_BUCKET: R2Bucket;
  DB?: D1Database;
  ACCOUNT_AUTH_SECRET?: string;
  ACCOUNT_AUTH_TOKEN_TTL_MS?: string;
  ALLOW_INSECURE_ACCOUNT_HEADER?: string;
}

const NULLPLUG_SUBMIT_BODY_MAX_BYTES = 512_000;

const parseResponseFact = (rawBody: string): NullplugUiResponseFact | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }

  return isNullplugUiResponseFact(parsed) ? parsed : null;
};

const handlePost = async (env: Env, request: Request): Promise<Response> => {
  const logger = createRequestLogger({
    request,
    env,
    route: "/api/nullplug/submit",
  });
  logger.logStart();

  try {
    if (!env.R2_BUCKET) {
      logger.logEnd(500, { reason: "bucket_missing" });
      return new Response("R2 bucket binding is required.", { status: 500 });
    }

    const serviceEnv: ResolvedHeapEnv = {
      R2_BUCKET: createCloudflareBlobStore(env.R2_BUCKET),
      DB: createCloudflareSqlStore(env.DB),
      ACCOUNT_AUTH_SECRET: env.ACCOUNT_AUTH_SECRET,
      ACCOUNT_AUTH_TOKEN_TTL_MS: env.ACCOUNT_AUTH_TOKEN_TTL_MS,
      ALLOW_INSECURE_ACCOUNT_HEADER: env.ALLOW_INSECURE_ACCOUNT_HEADER,
    };

    const rawBody = await readRequestTextWithLimit(
      request,
      NULLPLUG_SUBMIT_BODY_MAX_BYTES,
    );
    const parsed = parseResponseFact(rawBody);
    if (!parsed) {
      logger.logEnd(400, { reason: "invalid_response_fact" });
      return jsonErrorResponse(
        400,
        "validation_failed",
        "Invalid nullplug UI response fact.",
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
        "Nullplug UI responses must target a branch.",
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
    if (!canonicalRootDropId) {
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

    if (!(await env.R2_BUCKET.get(canonicalRootDropId))) {
      logger.logEnd(404, {
        reason: "root_drop_not_found",
        rootDropRef: toLogRef(canonicalRootDropId),
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
        "You are not allowed to submit responses for this branch.",
      );
    }
    if (branch.status !== "active") {
      logger.logEnd(409, { reason: "branch_not_active" });
      return jsonErrorResponse(
        409,
        "branch_not_active",
        "Nullplug responses require an active branch.",
      );
    }
    if (!parsed.source.sourceContentHash) {
      logger.logEnd(400, { reason: "source_hash_required" });
      return jsonErrorResponse(
        400,
        "source_hash_required",
        "Nullplug responses must include the rendered source hash.",
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
      (await hashMarkdownSource(branchContent)) !== parsed.source.sourceContentHash
    ) {
      logger.logEnd(409, { reason: "stale_source" });
      return jsonErrorResponse(
        409,
        "stale_source",
        "The approval was rendered for an older branch revision.",
      );
    }

    const fact: NullplugUiResponseFact = {
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
    const { key, written } = await putNullplugUiResponseFact(
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resolverId: RESOLVED_RUNTIME_REFS_RESOLVER_ID,
          snapshotId: "latest",
        }),
      }),
    );
    const indexed = projectionResponse.ok;
    if (!indexed) {
      logger.logError(
        "nullplug.submit.index_failed",
        new Error(await projectionResponse.text()),
      );
    }

    logger.logEnd(200, {
      rootDropRef: toLogRef(canonicalRootDropId),
      branchRef: toLogRef(fact.source.branchId),
      primitiveId: fact.primitiveId,
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
    logger.logError("nullplug.submit.unhandled_error", error);
    logger.logEnd(500, { reason: "unhandled_error" });
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Failed to submit nullplug response: ${message}`, {
      status: 500,
    });
  }
};

const handleRequest = async (context: {
  request: Request;
  env: Env;
}): Promise<Response> => {
  if (context.request.method === "POST") {
    return handlePost(context.env, context.request);
  }

  return methodNotAllowedResponse();
};

export const onRequest = handleRequest;

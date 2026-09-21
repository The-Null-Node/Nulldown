/*
 `/api/nullplug/submit` stores atomic UI responses as immutable facts. Proposed diffs
 stay data until a separate policy grant accepts them into branch diffs.
*/

import {
  isNullplugUiResponseFact,
  type NullplugUiResponseFact,
} from "../../../../shared/nullplug/ui";
import {
  putNullplugUiResponseFact,
  readNullplugUiResponseFact,
} from "./facts/repository";
import { createDropIdentityRepository } from "../drops/identity/id";
import { resolveAuthenticatedAccountId } from "../accounts/session/auth";
import { createBranchRepository } from "../branches/storage/repository";
import { readBranchContent } from "../branches/content/replay";
import { createBranchRuntimeFactLogRepository } from "../branches/storage/runtimeFactLogRepository";
import {
  BranchMutationLockError,
  withBranchMutationLock,
} from "../branches/storage/mutationLock";
import { sanitizeDiffAuthToken } from "../diffs/credentials/repository";
import { updateResolvedHeap } from "../resolved/heap/service";
import { RESOLVED_RUNTIME_REFS_RESOLVER_ID } from "../../../../shared/drop/resolved/constants";
import { hashMarkdownSource } from "../../../../shared/drop/resolved/hash";
import { serializeCanonicalJson } from "../../../../shared/drop/types";
import type { ResolvedHeapEnv } from "../resolved/heap/types";
import { createRequestLogger, toLogRef } from "../core/logging/logger";
import {
  jsonErrorResponse,
  jsonResponse,
  methodNotAllowedResponse,
  readRequestTextWithLimit,
} from "../core/http/responses";

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

const handlePost = async (
  env: ResolvedHeapEnv,
  request: Request,
): Promise<Response> => {
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

    const serviceEnv = env;

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

    if (!(await serviceEnv.R2_BUCKET.get(canonicalRootDropId))) {
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
    const committed = await withBranchMutationLock(
      serviceEnv.R2_BUCKET,
      canonicalRootDropId,
      branchId,
      async (lock) => {
        const lockedBranch = await branchRepository.readBranch(
          canonicalRootDropId,
          branchId,
        );
        if (!lockedBranch) {
          return {
            error: jsonErrorResponse(404, "branch_not_found", "Branch not found."),
          } as const;
        }
        if (
          accountId !== lockedBranch.ownerAccountId &&
          accountId !== lockedBranch.writerAccountId
        ) {
          return {
            error: jsonErrorResponse(
              403,
              "forbidden",
              "You are not allowed to submit responses for this branch.",
            ),
          } as const;
        }

        const requestedFact: NullplugUiResponseFact = {
          ...parsed,
          source: {
            ...parsed.source,
            rootDropId: canonicalRootDropId,
            branchId,
          },
          metadata: { ...parsed.metadata, actorAccountId: accountId },
        };
        const existingFact = await readNullplugUiResponseFact(
          serviceEnv.R2_BUCKET,
          requestedFact,
        );
        const runtimeFactRepository = createBranchRuntimeFactLogRepository({
          blobs: serviceEnv.R2_BUCKET,
          sql: serviceEnv.DB,
        });
        if (existingFact) {
          const normalizedRetry: NullplugUiResponseFact = {
            ...requestedFact,
            createdAt: existingFact.createdAt,
            source: {
              ...requestedFact.source,
              snapshotId: existingFact.source.snapshotId,
            },
          };
          if (
            serializeCanonicalJson(normalizedRetry) !==
            serializeCanonicalJson(existingFact)
          ) {
            return {
              error: jsonErrorResponse(
                409,
                "idempotency_key_reused",
                "The response identity was already used for different data.",
              ),
            } as const;
          }
          await lock.beginCommit();
          const { key, fact } = await putNullplugUiResponseFact(
            serviceEnv.R2_BUCKET,
            existingFact,
            serviceEnv.DB,
          );
          const runtimeFact =
            await runtimeFactRepository.appendBranchRuntimeFactUnderLock(
              canonicalRootDropId,
              branchId,
              fact,
            );
          return { fact, key, written: false, runtimeFact } as const;
        }
        if (lockedBranch.status !== "active") {
          return {
            error: jsonErrorResponse(
              409,
              "branch_not_active",
              "Nullplug responses require an active branch.",
            ),
          } as const;
        }
        if (!parsed.source.sourceContentHash) {
          return {
            error: jsonErrorResponse(
              400,
              "source_hash_required",
              "Nullplug responses must include the rendered source hash.",
            ),
          } as const;
        }
        const branchContent = await readBranchContent(
          serviceEnv.R2_BUCKET,
          canonicalRootDropId,
          branchId,
          lockedBranch.headSnapshotId,
          serviceEnv.DB,
        );
        if (
          branchContent === null ||
          (await hashMarkdownSource(branchContent)) !==
            parsed.source.sourceContentHash
        ) {
          return {
            error: jsonErrorResponse(
              409,
              "stale_source",
              "The approval was rendered for an older branch revision.",
            ),
          } as const;
        }

        const candidateFact: NullplugUiResponseFact = {
          ...requestedFact,
          createdAt: Date.now(),
          source: {
            ...requestedFact.source,
            snapshotId: lockedBranch.headSnapshotId,
          },
        };
        await lock.beginCommit();
        const { key, written, fact } = await putNullplugUiResponseFact(
          serviceEnv.R2_BUCKET,
          candidateFact,
          serviceEnv.DB,
        );
        const runtimeFact =
          await runtimeFactRepository.appendBranchRuntimeFactUnderLock(
            canonicalRootDropId,
            branchId,
            fact,
          );
        return { fact, key, written, runtimeFact } as const;
      },
    );
    if ("error" in committed) {
      if (!committed.error) throw new Error("Missing Nullplug response error.");
      return committed.error;
    }
    const { fact, key, written, runtimeFact } = committed;

    const projectionHeaders = new Headers(request.headers);
    projectionHeaders.set("Content-Type", "application/json");
    const projectionResponse = await updateResolvedHeap(
      serviceEnv,
      { rootId: canonicalRootDropId, branchId },
      new Request(request.url, {
        method: "POST",
        headers: projectionHeaders,
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
    if (error instanceof BranchMutationLockError) {
      const status = error.outcome === "not_committed" ? 409 : 503;
      logger.logEnd(status, { reason: error.code });
      return jsonErrorResponse(
        status,
        error.code,
        error.outcome === "not_committed"
          ? "Branch lock was not held before commit. Refresh and retry."
          : "Mutation outcome could not be confirmed. Retry the exact same response.",
      );
    }
    logger.logError("nullplug.submit.unhandled_error", error);
    logger.logEnd(500, { reason: "unhandled_error" });
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Failed to submit nullplug response: ${message}`, {
      status: 500,
    });
  }
};

/** Handles the portable HTTP contract for Nullplug UI response submission. */
export const handleNullplugResponseRequest = async (context: {
  request: Request;
  env: ResolvedHeapEnv;
}): Promise<Response> => {
  if (context.request.method === "POST") {
    return handlePost(context.env, context.request);
  }

  return methodNotAllowedResponse();
};

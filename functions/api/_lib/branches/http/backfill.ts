import { z } from "zod";
import { verifyBearerToken } from "../../core/auth/bearer";
import {
  apiHttpErrorResponse,
  isApiHttpError,
  jsonErrorResponse,
  jsonResponse,
  parseWithSchema,
  resolveParam,
  type JsonValue,
} from "../../core/http/responses";
import { createRequestLogger, toLogRef } from "../../core/logging/logger";
import { createDropIdentityRepository } from "../../drops/identity/id";
import { backfillBranchToSnapshotHeap } from "../lifecycle";
import {
  createBranchRouteRepository,
  type BranchRootParams,
  type BranchRouteEnv,
} from "./request-context";

const DEFAULT_BACKFILL_LIMIT = 100;
const MAX_BACKFILL_LIMIT = 1000;

const branchBackfillQuerySchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z
      .string()
      .regex(/^\d+$/)
      .transform((value) => Number.parseInt(value, 10))
      .pipe(z.number().int().min(1).max(MAX_BACKFILL_LIMIT))
      .optional(),
  })
  .strict();

type BranchBackfillQuery = z.infer<typeof branchBackfillQuerySchema>;

const parseBranchBackfillQuery = (request: Request): BranchBackfillQuery => {
  const url = new URL(request.url);
  const query: { [key: string]: JsonValue } = {};
  const cursor = url.searchParams.get("cursor");
  const limit = url.searchParams.get("limit");

  if (cursor !== null) query.cursor = cursor;
  if (limit !== null) query.limit = limit;

  return parseWithSchema(
    branchBackfillQuerySchema,
    query,
    "Invalid branch backfill query.",
  );
};

/** Backfills one root's branches into heap-v2 snapshot/event storage. */
export const backfillBranchesForDrop = async (
  env: BranchRouteEnv,
  params: BranchRootParams,
  request: Request,
): Promise<Response> => {
  const logger = createRequestLogger({
    request,
    env,
    route: "/api/branches/backfill/:id",
  });

  const requestedRootId = resolveParam(params.id);
  logger.logStart({ requestedDropRef: toLogRef(requestedRootId) });

  try {
    if (!env.R2_BUCKET) {
      logger.logEnd(500, { reason: "bucket_missing" });
      return jsonErrorResponse(
        500,
        "bucket_missing",
        "R2 bucket binding is required.",
      );
    }

    if (!env.BRANCH_HEAP_BACKFILL_TOKEN) {
      logger.logEnd(503, { reason: "token_missing" });
      return jsonErrorResponse(
        503,
        "token_missing",
        "BRANCH_HEAP_BACKFILL_TOKEN is required.",
      );
    }

    if (!verifyBearerToken(request, env.BRANCH_HEAP_BACKFILL_TOKEN)) {
      logger.logEnd(401, { reason: "unauthorized" });
      return jsonErrorResponse(401, "unauthorized", "Unauthorized");
    }

    const dropIdentityRepository = createDropIdentityRepository({
      blobs: env.R2_BUCKET,
      sql: env.DB,
    });
    const rootDropId =
      await dropIdentityRepository.resolveRemoteDropId(requestedRootId);
    if (!rootDropId) {
      logger.logEnd(400, { reason: "invalid_drop_id" });
      return jsonErrorResponse(
        400,
        "invalid_drop_id",
        "Root drop ID is required.",
      );
    }

    const query = parseBranchBackfillQuery(request);
    const inputCursor = query.cursor;
    const limit = query.limit ?? DEFAULT_BACKFILL_LIMIT;
    const branchRepository = createBranchRouteRepository(env);
    const page = await branchRepository.listBranchesForRootPage(
      rootDropId,
      limit,
      inputCursor,
    );

    const stats = {
      rootDropId,
      scanned: page.branches.length,
      migrated: 0,
      alreadyV2: 0,
      missing: 0,
      failed: 0,
    };

    for (const branch of page.branches) {
      const wasV2 =
        branch.snapshotHeapVersion === 2 &&
        typeof branch.headEventSeq === "number";

      try {
        const upgraded = await backfillBranchToSnapshotHeap(
          env.R2_BUCKET,
          rootDropId,
          branch.branchId,
          env.DB,
        );
        if (!upgraded) {
          stats.missing += 1;
        } else if (wasV2) {
          stats.alreadyV2 += 1;
        } else {
          stats.migrated += 1;
        }
      } catch {
        stats.failed += 1;
      }
    }

    logger.logEnd(200, {
      rootDropRef: toLogRef(rootDropId),
      scanned: stats.scanned,
      migrated: stats.migrated,
      alreadyV2: stats.alreadyV2,
      missing: stats.missing,
      failed: stats.failed,
      truncated: page.truncated,
      hasCursor: Boolean(inputCursor),
      hasNextCursor: Boolean(page.cursor),
    });

    return jsonResponse({
      stats,
      truncated: page.truncated,
      cursor: page.cursor,
    });
  } catch (error: unknown) {
    if (isApiHttpError(error)) {
      logger.logEnd(error.status, {
        reason: error.code,
        requestedDropRef: toLogRef(requestedRootId),
      });
      return apiHttpErrorResponse(error);
    }

    const message = error instanceof Error ? error.message : String(error);
    logger.logError("branches.backfill.unhandled_error", error, {
      requestedDropRef: toLogRef(requestedRootId),
    });
    logger.logEnd(500, { reason: "unhandled_error" });
    return jsonErrorResponse(
      500,
      "unhandled_error",
      `Failed to backfill branch heap: ${message}`,
    );
  }
};

import { z } from "zod";
import type { VoidBlobStore, VoidSqlStore } from "../../../../../src/server/ports";
import { verifyBearerToken } from "../../core/auth/bearer";
import {
  resolveAuthenticatedAccountId,
  type AccountAuthEnv,
} from "../../accounts/session/auth";
import {
  backfillBranchToSnapshotHeapV2,
  resolveBranchForActor,
} from "../lifecycle/service";
import { readBranchContent } from "../content/replay";
import {
  listBranchesForRoot,
  listBranchesForRootPage,
  listSnapshotsForBranch,
  readBranch,
} from "../storage/repository";
import { sanitizeDiffAuthToken } from "../../diffs/credentials/repository";
import { resolveRemoteDropId } from "../../drops/identity/id";
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

/** Environment required by branch route services. */
export interface BranchRouteEnv extends AccountAuthEnv {
  R2_BUCKET: VoidBlobStore;
  DB?: VoidSqlStore;
  PROVIDER_ENCRYPTION_PRIVATE_JWK?: string;
  BRANCH_HEAP_BACKFILL_TOKEN?: string;
}

/** Route params for root-only branch operations. */
export interface BranchRootParams {
  id: string | string[];
}

/** Route params for branch-specific operations. */
export interface BranchTargetParams {
  rootId: string | string[];
  branchId: string | string[];
}

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

  if (cursor !== null) {
    query.cursor = cursor;
  }
  if (limit !== null) {
    query.limit = limit;
  }

  return parseWithSchema(
    branchBackfillQuerySchema,
    query,
    "Invalid branch backfill query.",
  );
};

const resolveRootDropId = async (
  env: Pick<BranchRouteEnv, "R2_BUCKET" | "DB">,
  idParam: string | string[] | undefined,
): Promise<string | null> => resolveRemoteDropId(env.R2_BUCKET, resolveParam(idParam), undefined, env.DB);

const resolveBranchTarget = async (
  env: Pick<BranchRouteEnv, "R2_BUCKET" | "DB">,
  params: BranchTargetParams,
): Promise<
  | { rootDropId: string; branchId: string }
  | { error: Response }
> => {
  const rootDropId = await resolveRemoteDropId(
    env.R2_BUCKET,
    resolveParam(params.rootId),
    undefined,
    env.DB,
  );
  const branchId = sanitizeDiffAuthToken(resolveParam(params.branchId));
  if (!rootDropId || !branchId) {
    return {
      error: new Response("Root drop ID and branch ID are required.", {
        status: 400,
      }),
    };
  }

  return { rootDropId, branchId };
};

/** Lists branches for a root drop. */
export const listBranchesForDrop = async (
  env: BranchRouteEnv,
  params: BranchRootParams,
): Promise<Response> => {
  if (!env.R2_BUCKET) {
    return new Response("R2 bucket binding is required.", { status: 500 });
  }

  const id = await resolveRootDropId(env, params.id);
  if (!id) {
    return new Response("Drop ID is required.", { status: 400 });
  }

  const branches = await listBranchesForRoot(env.R2_BUCKET, id, env.DB);
  return new Response(JSON.stringify({ rootDropId: id, branches }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

/** Resolves or creates the branch assigned to the authenticated account/client. */
export const resolveBranchForRequest = async (
  env: BranchRouteEnv,
  params: BranchRootParams,
  request: Request,
): Promise<Response> => {
  if (!env.R2_BUCKET) {
    return new Response("R2 bucket binding is required.", { status: 500 });
  }

  const id = await resolveRootDropId(env, params.id);
  if (!id) {
    return new Response("Drop ID is required.", { status: 400 });
  }

  const accountId = await resolveAuthenticatedAccountId(request, env);
  if (!accountId) {
    return new Response("Authenticated account session is required.", {
      status: 401,
    });
  }
  const clientId = sanitizeDiffAuthToken(
    request.headers.get("x-nulldown-client-id") ||
      new URL(request.url).searchParams.get("clientId"),
  );

  try {
    const { branch, created } = await resolveBranchForActor(
      env.R2_BUCKET,
      id,
      accountId,
      clientId,
      env.PROVIDER_ENCRYPTION_PRIVATE_JWK,
      env.DB,
    );

    return new Response(
      JSON.stringify({
        rootDropId: id,
        branchId: branch.branchId,
        mode: branch.mode,
        created,
        headSnapshotId: branch.headSnapshotId,
        ownerAccountId: branch.ownerAccountId,
        writerAccountId: branch.writerAccountId,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Failed to resolve branch: ${message}`, { status: 400 });
  }
};

/** Returns materialized branch-head content. */
export const getBranchContent = async (
  env: BranchRouteEnv,
  params: BranchTargetParams,
): Promise<Response> => {
  if (!env.R2_BUCKET) {
    return new Response("R2 bucket binding is required.", { status: 500 });
  }

  const target = await resolveBranchTarget(env, params);
  if ("error" in target) return target.error;
  const { rootDropId, branchId } = target;

  const branch = await readBranch(env.R2_BUCKET, rootDropId, branchId, env.DB);
  if (!branch) {
    return new Response("Branch not found.", { status: 404 });
  }

  const content = await readBranchContent(
    env.R2_BUCKET,
    rootDropId,
    branchId,
    branch.headSnapshotId,
    env.DB,
  );
  if (content === null) {
    return new Response("Branch content not found.", { status: 404 });
  }

  return new Response(
    JSON.stringify({
      rootDropId,
      branchId,
      snapshotId: branch.headSnapshotId,
      content,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
};

/** Lists stored branch snapshots for a branch. */
export const listBranchSnapshots = async (
  env: BranchRouteEnv,
  params: BranchTargetParams,
): Promise<Response> => {
  if (!env.R2_BUCKET) {
    return new Response("R2 bucket binding is required.", { status: 500 });
  }

  const target = await resolveBranchTarget(env, params);
  if ("error" in target) return target.error;
  const { rootDropId, branchId } = target;

  const branch = await readBranch(env.R2_BUCKET, rootDropId, branchId, env.DB);
  if (!branch) {
    return new Response("Branch not found.", { status: 404 });
  }

  const snapshots = await listSnapshotsForBranch(
    env.R2_BUCKET,
    rootDropId,
    branchId,
    env.DB,
  );
  return new Response(JSON.stringify({ rootDropId, branchId, snapshots }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

/** Backfills branch records for one root drop into heap-v2 snapshot/event storage. */
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

    const rootDropId = await resolveRemoteDropId(env.R2_BUCKET, requestedRootId, undefined, env.DB);
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

    const page = await listBranchesForRootPage(
      env.R2_BUCKET,
      rootDropId,
      limit,
      inputCursor,
      env.DB,
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
        const upgraded = await backfillBranchToSnapshotHeapV2(
          env.R2_BUCKET,
          rootDropId,
          branch.branchId,
          env.DB,
        );

        if (!upgraded) {
          stats.missing += 1;
          continue;
        }

        if (wasV2) {
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

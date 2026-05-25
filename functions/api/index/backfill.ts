import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import { z } from "zod";
import { isDropIdToken } from "../../../shared/drop/id";
import { isDropEnvelopeV1 } from "../../../shared/drop/types";
import {
  isRemotePublicDropIndexKey,
  removePublicDropIndexEntry,
  upsertPublicDropIndexEntry,
} from "../_lib/dropIndex";
import { REMOTE_DROP_ALIAS_PREFIX, reserveRemoteAlias } from "../_lib/dropId";
import { createRequestLogger } from "../_lib/logger";
import { verifyBearerToken } from "../_lib/auth";
import {
  apiHttpErrorResponse,
  isApiHttpError,
  jsonErrorResponse,
  jsonResponse,
  methodNotAllowedResponse,
  parseWithSchema,
  type JsonValue,
} from "../_lib/http";

interface Env {
  R2_BUCKET: R2Bucket;
  DROP_INDEX_BACKFILL_TOKEN?: string;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

const backfillQuerySchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z
      .string()
      .regex(/^\d+$/)
      .transform((value) => Number.parseInt(value, 10))
      .pipe(z.number().int().min(1).max(MAX_LIMIT))
      .optional(),
  })
  .strict();

type BackfillQuery = z.infer<typeof backfillQuerySchema>;

const parseBackfillQuery = (request: Request): BackfillQuery => {
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
    backfillQuerySchema,
    query,
    "Invalid drop index backfill query.",
  );
};

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const logger = createRequestLogger({
    request,
    env,
    route: "/api/index/backfill",
  });

  logger.logStart();

  try {
    if (!env.R2_BUCKET) {
      logger.logEnd(500, { reason: "bucket_binding_missing" });
      return jsonErrorResponse(
        500,
        "bucket_binding_missing",
        "R2 bucket binding is required.",
      );
    }

    if (!env.DROP_INDEX_BACKFILL_TOKEN) {
      logger.logEnd(503, { reason: "backfill_token_missing" });
      return jsonErrorResponse(
        503,
        "backfill_token_missing",
        "DROP_INDEX_BACKFILL_TOKEN is required.",
      );
    }

    if (!verifyBearerToken(request, env.DROP_INDEX_BACKFILL_TOKEN)) {
      logger.logEnd(401, { reason: "unauthorized" });
      return jsonErrorResponse(401, "unauthorized", "Unauthorized");
    }

    const query = parseBackfillQuery(request);
    const cursor = query.cursor;
    const limit = query.limit ?? DEFAULT_LIMIT;

    const listed = await env.R2_BUCKET.list({
      limit,
      cursor,
    });

    const stats = {
      scanned: 0,
      skippedAlias: 0,
      skippedIndex: 0,
      skippedInternal: 0,
      skippedNonDropKey: 0,
      aliasReserved: 0,
      aliasAlreadyRegistered: 0,
      aliasConflict: 0,
      missingObject: 0,
      nonJsonObject: 0,
      invalidJsonObject: 0,
      indexUpserted: 0,
      indexRemoved: 0,
    };

    for (const entry of listed.objects) {
      stats.scanned += 1;

      if (entry.key.startsWith(REMOTE_DROP_ALIAS_PREFIX)) {
        stats.skippedAlias += 1;
        continue;
      }

      if (isRemotePublicDropIndexKey(entry.key)) {
        stats.skippedIndex += 1;
        continue;
      }

      if (entry.key.startsWith("__")) {
        stats.skippedInternal += 1;
        continue;
      }

      if (!isDropIdToken(entry.key)) {
        stats.skippedNonDropKey += 1;
        continue;
      }

      const aliasState = await reserveRemoteAlias(env.R2_BUCKET, entry.key, logger);
      if (aliasState === "reserved") {
        stats.aliasReserved += 1;
      } else if (aliasState === "already-registered") {
        stats.aliasAlreadyRegistered += 1;
      } else {
        stats.aliasConflict += 1;
      }

      const object = await env.R2_BUCKET.get(entry.key);
      if (!object?.body) {
        stats.missingObject += 1;
        continue;
      }

      const contentType = object.httpMetadata?.contentType || "";
      if (!contentType.includes("application/json")) {
        stats.nonJsonObject += 1;
        await removePublicDropIndexEntry(env.R2_BUCKET, entry.key);
        stats.indexRemoved += 1;
        continue;
      }

      let parsed: JsonValue;
      try {
        parsed = (await new Response(object.body).json()) as JsonValue;
      } catch {
        stats.invalidJsonObject += 1;
        await removePublicDropIndexEntry(env.R2_BUCKET, entry.key);
        stats.indexRemoved += 1;
        continue;
      }

      if (isDropEnvelopeV1(parsed) && (parsed.visibility ?? "unlisted") === "public") {
        await upsertPublicDropIndexEntry(
          env.R2_BUCKET,
          entry.key,
          entry.uploaded.getTime(),
        );
        stats.indexUpserted += 1;
      } else {
        await removePublicDropIndexEntry(env.R2_BUCKET, entry.key);
        stats.indexRemoved += 1;
      }
    }

    logger.logEnd(200, {
      ...stats,
      limit,
      truncated: listed.truncated,
      hasCursor: Boolean(cursor),
    });

    return jsonResponse({
      stats,
      cursor: listed.truncated ? listed.cursor : null,
    });
  } catch (error) {
    if (isApiHttpError(error)) {
      logger.logEnd(error.status, { reason: error.code });
      return apiHttpErrorResponse(error);
    }

    logger.logError("index.backfill.unhandled_error", error);
    const message = error instanceof Error ? error.message : String(error);
    logger.logEnd(500, { reason: "unhandled_error" });
    return jsonErrorResponse(
      500,
      "unhandled_error",
      `Failed to backfill drop index: ${message}`,
    );
  }
};

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method === "POST") {
    return onRequestPost(context);
  }

  return methodNotAllowedResponse();
};

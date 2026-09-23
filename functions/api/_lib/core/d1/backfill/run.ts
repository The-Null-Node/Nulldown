import { verifyBearerToken } from "../../auth/bearer";
import { jsonErrorResponse, jsonResponse } from "../../http/responses";
import { type RequestLogger, toLogRef } from "../../logging/logger";
import { backfillAccountLibrary } from "./account-library";
import {
  createMetadataBackfillStats,
  type MetadataBackfillEnv,
} from "./contracts";
import { projectR2MetadataObject } from "./r2-projection";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

const parseLimit = (value: string | null): number => {
  if (!value) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(MAX_LIMIT, parsed))
    : DEFAULT_LIMIT;
};

/** Scans R2 metadata objects and mirrors queryable records into D1. */
export const backfillD1Metadata = async (
  env: MetadataBackfillEnv,
  request: Request,
  logger?: RequestLogger,
): Promise<Response> => {
  if (!env.R2_BUCKET) {
    return jsonErrorResponse(
      500,
      "bucket_missing",
      "R2 bucket binding is required.",
    );
  }
  if (!env.DB) {
    return jsonErrorResponse(503, "db_missing", "DB D1 binding is required.");
  }

  const token = env.METADATA_BACKFILL_TOKEN ?? env.DROP_INDEX_BACKFILL_TOKEN;
  if (!token) {
    return jsonErrorResponse(
      503,
      "token_missing",
      "METADATA_BACKFILL_TOKEN is required.",
    );
  }
  if (!verifyBearerToken(request, token)) {
    return jsonErrorResponse(401, "unauthorized", "Unauthorized");
  }

  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limit = parseLimit(url.searchParams.get("limit"));
  if (url.searchParams.get("mode") === "account-library") {
    return backfillAccountLibrary(env, cursor, limit, logger);
  }

  const listed = await env.R2_BUCKET.list({ limit, cursor });
  const stats = createMetadataBackfillStats();

  for (const entry of listed.objects) {
    stats.scanned += 1;
    try {
      await projectR2MetadataObject(
        { R2_BUCKET: env.R2_BUCKET, DB: env.DB },
        entry.key,
        stats,
      );
    } catch (error) {
      stats.failed += 1;
      logger?.warn("metadata.backfill.object_failed", {
        keyRef: toLogRef(entry.key),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return jsonResponse({
    stats,
    cursor: listed.truncated ? listed.cursor : null,
    truncated: listed.truncated,
  });
};

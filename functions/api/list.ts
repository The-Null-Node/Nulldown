import type { D1Database, PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import {
  REMOTE_PUBLIC_DROP_INDEX_PREFIX,
  listPublicDropIndexEntries,
  readPublicDropIndexEntryByKey,
} from "./_lib/drops/index/repository";
import { createRequestLogger } from "./_lib/core/logging/logger";

interface Env {
  R2_BUCKET: R2Bucket;
  DB?: D1Database;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const READ_SUCCESS_SAMPLE_RATE = 0.1;

type PublicListItem = { id: string; createdAt: number; updatedAt: number };

type ListScanResult =
  | { kind: "item"; item: PublicListItem }
  | {
      kind: "skip";
      reason: "invalid_index_entry";
    };

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const logger = createRequestLogger({
    request,
    env,
    route: "/api/list",
    successSampleRate: READ_SUCCESS_SAMPLE_RATE,
  });

  logger.logStart();

  try {
    if (!env.R2_BUCKET) {
      logger.error("list.bucket_binding_missing");
      logger.logEnd(500, {
        reason: "bucket_binding_missing",
      });
      return new Response("R2 bucket binding is required.", { status: 500 });
    }

    const url = new URL(request.url);
    const limitParam = Number.parseInt(url.searchParams.get("limit") || "", 10);
    const limit = Number.isFinite(limitParam)
      ? Math.max(1, Math.min(MAX_LIMIT, limitParam))
      : DEFAULT_LIMIT;
    const cursor = url.searchParams.get("cursor") || undefined;

    if (env.DB) {
      const listed = await listPublicDropIndexEntries(env.DB, limit, cursor);
      logger.logEnd(200, {
        limit,
        hasCursor: Boolean(cursor),
        returned: listed.items.length,
        source: "d1",
      });

      return new Response(JSON.stringify(listed), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    const listed = await env.R2_BUCKET.list({
      prefix: REMOTE_PUBLIC_DROP_INDEX_PREFIX,
      limit,
      cursor,
    });

    const scanned = await Promise.all(
      listed.objects.map(async (entry) => {
        const indexEntry = await readPublicDropIndexEntryByKey(
          env.R2_BUCKET,
          entry.key,
        );
        if (!indexEntry) {
          return {
            kind: "skip",
            reason: "invalid_index_entry",
          } satisfies ListScanResult;
        }

        return {
          kind: "item",
          item: {
            id: indexEntry.id,
            createdAt: indexEntry.createdAt,
            updatedAt: indexEntry.updatedAt,
          },
        } satisfies ListScanResult;
      }),
    );

    const skipCounts = {
      invalid_index_entry: 0,
    };

    const items = scanned.flatMap((result) => {
      if (result.kind === "item") {
        return [result.item];
      }

      skipCounts[result.reason] += 1;
      return [];
    });

    items.sort((a, b) => b.updatedAt - a.updatedAt);

    logger.logEnd(200, {
      limit,
      hasCursor: Boolean(cursor),
      returned: items.length,
      scanned: listed.objects.length,
      truncated: listed.truncated,
      skipInvalidIndexEntry: skipCounts.invalid_index_entry,
    });

    return new Response(
      JSON.stringify({
        items,
        cursor: listed.truncated ? listed.cursor : null,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error: unknown) {
    logger.logError("list.unhandled_error", error);
    const message = error instanceof Error ? error.message : String(error);
    logger.logEnd(500, {
      reason: "unhandled_error",
    });
    return new Response(`Failed to list drops: ${message}`, { status: 500 });
  }
};

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method === "GET") {
    return onRequestGet(context);
  }

  const logger = createRequestLogger({
    request: context.request,
    env: context.env,
    route: "/api/list",
    successSampleRate: READ_SUCCESS_SAMPLE_RATE,
  });

  logger.logStart();
  logger.warn("list.method_not_allowed", {
    attemptedMethod: context.request.method,
  });
  logger.logEnd(405, {
    reason: "method_not_allowed",
  });

  return new Response("Method Not Allowed", { status: 405 });
};

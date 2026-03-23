import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import { isDropEnvelopeV1 } from "../../shared/drop/types";
import { REMOTE_DROP_ALIAS_PREFIX } from "./_lib/dropId";
import { createRequestLogger } from "./_lib/logger";

interface Env {
  R2_BUCKET: R2Bucket;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const READ_SUCCESS_SAMPLE_RATE = 0.1;

type PublicListItem = { id: string; createdAt: number; updatedAt: number };

type ListScanResult =
  | { kind: "item"; item: PublicListItem }
  | {
      kind: "skip";
      reason:
        | "alias"
        | "missing_object"
        | "non_json"
        | "invalid_json"
        | "non_envelope"
        | "non_public";
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

    const listed = await env.R2_BUCKET.list({ limit, cursor });

    const scanned = await Promise.all(
      listed.objects.map(async (entry) => {
        if (entry.key.startsWith(REMOTE_DROP_ALIAS_PREFIX)) {
          return {
            kind: "skip",
            reason: "alias",
          } satisfies ListScanResult;
        }

        const object = await env.R2_BUCKET.get(entry.key);
        if (!object) {
          return {
            kind: "skip",
            reason: "missing_object",
          } satisfies ListScanResult;
        }

        const contentType = object.httpMetadata?.contentType || "";
        if (!contentType.includes("application/json")) {
          return {
            kind: "skip",
            reason: "non_json",
          } satisfies ListScanResult;
        }

        const serialized = await new Response(object.body).text();

        try {
          const parsed = JSON.parse(serialized) as unknown;
          if (!isDropEnvelopeV1(parsed)) {
            return {
              kind: "skip",
              reason: "non_envelope",
            } satisfies ListScanResult;
          }

          if ((parsed.visibility ?? "unlisted") !== "public") {
            return {
              kind: "skip",
              reason: "non_public",
            } satisfies ListScanResult;
          }

          return {
            kind: "item",
            item: {
              id: entry.key,
              createdAt: entry.uploaded.getTime(),
              updatedAt: entry.uploaded.getTime(),
            },
          } satisfies ListScanResult;
        } catch {
          return {
            kind: "skip",
            reason: "invalid_json",
          } satisfies ListScanResult;
        }
      }),
    );

    const skipCounts = {
      alias: 0,
      missing_object: 0,
      non_json: 0,
      invalid_json: 0,
      non_envelope: 0,
      non_public: 0,
    };

    const items = scanned.flatMap((result) => {
      if (result.kind === "item") {
        return [result.item];
      }

      skipCounts[result.reason] += 1;
      return [];
    });

    logger.logEnd(200, {
      limit,
      hasCursor: Boolean(cursor),
      returned: items.length,
      scanned: listed.objects.length,
      truncated: listed.truncated,
      skipAlias: skipCounts.alias,
      skipMissingObject: skipCounts.missing_object,
      skipNonJson: skipCounts.non_json,
      skipInvalidJson: skipCounts.invalid_json,
      skipNonEnvelope: skipCounts.non_envelope,
      skipNonPublic: skipCounts.non_public,
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

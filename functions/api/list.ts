import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import { isDropEnvelopeV1 } from "../../shared/drop/types";
import { REMOTE_DROP_ALIAS_PREFIX } from "./_lib/dropId";

interface Env {
  R2_BUCKET: R2Bucket;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  try {
    if (!env.R2_BUCKET) {
      return new Response("R2 bucket binding is required.", { status: 500 });
    }

    const url = new URL(request.url);
    const limitParam = Number.parseInt(url.searchParams.get("limit") || "", 10);
    const limit = Number.isFinite(limitParam)
      ? Math.max(1, Math.min(MAX_LIMIT, limitParam))
      : DEFAULT_LIMIT;
    const cursor = url.searchParams.get("cursor") || undefined;

    const listed = await env.R2_BUCKET.list({ limit, cursor });

    const filtered = await Promise.all(
      listed.objects.map(async (entry) => {
        if (entry.key.startsWith(REMOTE_DROP_ALIAS_PREFIX)) {
          return null;
        }

        const object = await env.R2_BUCKET.get(entry.key);
        if (!object) {
          return null;
        }

        const contentType = object.httpMetadata?.contentType || "";
        if (!contentType.includes("application/json")) {
          return null;
        }

        const serialized = await new Response(object.body).text();

        try {
          const parsed = JSON.parse(serialized) as unknown;
          if (!isDropEnvelopeV1(parsed)) {
            return null;
          }

          if ((parsed.visibility ?? "unlisted") !== "public") {
            return null;
          }

          return {
            id: entry.key,
            createdAt: entry.uploaded.getTime(),
            updatedAt: entry.uploaded.getTime(),
          };
        } catch {
          return null;
        }
      }),
    );

    return new Response(
      JSON.stringify({
        items: filtered.filter(
          (
            item,
          ): item is { id: string; createdAt: number; updatedAt: number } =>
            Boolean(item),
        ),
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
    console.error("Error listing drops:", error);
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Failed to list drops: ${message}`, { status: 500 });
  }
};

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method === "GET") {
    return onRequestGet(context);
  }

  return new Response("Method Not Allowed", { status: 405 });
};

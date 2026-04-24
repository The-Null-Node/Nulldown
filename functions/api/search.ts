import type { PagesFunction } from "@cloudflare/workers-types";
import { createSearchDatabase } from "../../src/lib/db/searchDatabase";
import { createRequestLogger, toLogRef } from "./_lib/logger";

interface Env {
  DB: D1Database;
}

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const logger = createRequestLogger({
    request,
    env,
    route: "/api/search",
    successSampleRate: 0.1,
  });

  logger.logStart();

  try {
    if (!env.DB) {
      logger.logEnd(500, { reason: "database_binding_missing" });
      return new Response("Database binding is required.", { status: 500 });
    }

    const url = new URL(request.url);
    const query = url.searchParams.get("q") || "";
    const ownerAccountId = url.searchParams.get("owner") || undefined;
    const visibility = url.searchParams.get("visibility") || undefined;
    const limitParam = Number.parseInt(url.searchParams.get("limit") || "", 10);
    const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(100, limitParam)) : 20;
    const offsetParam = Number.parseInt(url.searchParams.get("offset") || "", 10);
    const offset = Number.isFinite(offsetParam) ? Math.max(0, offsetParam) : 0;

    const db = createSearchDatabase(env.DB);
    
    const visibilities = visibility ? visibility.split(",") : undefined;
    
    const result = await db.search({
      query,
      ownerAccountId: ownerAccountId || null,
      visibility: visibilities,
      limit,
      offset,
    });

    logger.logEnd(200, {
      queryLength: query.length,
      results: result.records.length,
      total: result.total,
    });

    return new Response(
      JSON.stringify({
        records: result.records,
        total: result.total,
        query,
        limit,
        offset,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error: unknown) {
    logger.logError("search.unhandled_error", error);
    const message = error instanceof Error ? error.message : String(error);
    logger.logEnd(500, { reason: "unhandled_error" });
    return new Response(`Failed to search: ${message}`, { status: 500 });
  }
};

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method === "GET") {
    return onRequestGet(context);
  }

  const logger = createRequestLogger({
    request: context.request,
    env: context.env,
    route: "/api/search",
  });

  logger.logStart();
  logger.logEnd(405, { reason: "method_not_allowed" });

  return new Response("Method Not Allowed", { status: 405 });
};

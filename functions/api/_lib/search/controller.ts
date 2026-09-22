import type { SqlMetadataStore } from "../../../../src/server/ports";
import { createSearchDatabase } from "./repository";
import { createRequestLogger } from "../core/logging/logger";

/** Portable search dependencies and logging configuration for one request. */
export interface SearchEnv {
  DB?: SqlMetadataStore;
  LOG_LEVEL?: string;
}

/** Executes public discovery and response logging for one GET request. */
export const handleSearchGet = async (
  request: Request,
  env: SearchEnv,
): Promise<Response> => {
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
    const limitParam = Number.parseInt(url.searchParams.get("limit") || "", 10);
    const limit = Number.isFinite(limitParam)
      ? Math.max(1, Math.min(100, limitParam))
      : 20;
    const offsetParam = Number.parseInt(
      url.searchParams.get("offset") || "",
      10,
    );
    const offset = Number.isFinite(offsetParam) ? Math.max(0, offsetParam) : 0;

    const db = createSearchDatabase(env.DB);

    const result = await db.search({
      query,
      ownerAccountId: ownerAccountId || null,
      visibility: ["public"],
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
      },
    );
  } catch (error: unknown) {
    logger.logError("search.unhandled_error", error);
    const message = error instanceof Error ? error.message : String(error);
    logger.logEnd(500, { reason: "unhandled_error" });
    return new Response(`Failed to search: ${message}`, { status: 500 });
  }
};

/** Dispatches one search request, preserving GET-only method handling. */
export const handleSearchRequest = async (
  request: Request,
  env: SearchEnv,
): Promise<Response> => {
  if (request.method === "GET") {
    return handleSearchGet(request, env);
  }

  const logger = createRequestLogger({
    request,
    env,
    route: "/api/search",
  });

  logger.logStart();
  logger.logEnd(405, { reason: "method_not_allowed" });

  return new Response("Method Not Allowed", { status: 405 });
};

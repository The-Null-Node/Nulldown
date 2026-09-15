import type { D1Database, PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import {
  AccountLibraryError,
  listAuthenticatedAccountLibrary,
} from "../_lib/accounts/library/service";
import { createRequestLogger } from "../_lib/core/logging/logger";

interface Env {
  R2_BUCKET: R2Bucket;
  DB?: D1Database;
  ACCOUNT_AUTH_SECRET?: string;
  ALLOW_INSECURE_ACCOUNT_HEADER?: string;
}

const jsonError = (status: number, code: string, error: string): Response =>
  new Response(JSON.stringify({ error, code }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const logger = createRequestLogger({ request, env, route: "/api/account/library" });
  logger.logStart();
  try {
    const result = await listAuthenticatedAccountLibrary(request, env);
    result.responseHeaders.set("Content-Type", "application/json");
    result.responseHeaders.set("Cache-Control", "no-store");
    logger.logEnd(200, { resultCount: result.page.items.length });
    return new Response(JSON.stringify(result.page), { headers: result.responseHeaders });
  } catch (error) {
    if (error instanceof AccountLibraryError) {
      logger.logEnd(error.status, { reason: error.code });
      return jsonError(error.status, error.code, error.message);
    }
    logger.logError("account_library.unhandled_error", error);
    logger.logEnd(500, { reason: "unhandled_error" });
    return jsonError(500, "unhandled_error", "Failed to load account library.");
  }
};

export const onRequest: PagesFunction<Env> = async (context) =>
  context.request.method === "GET"
    ? onRequestGet(context)
    : new Response("Method Not Allowed", { status: 405 });

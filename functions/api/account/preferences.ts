import type { D1Database, PagesFunction } from "@cloudflare/workers-types";
import {
  AccountPreferencesError,
  readAccountPreferencesResponse,
  updateAccountPreferenceResponse,
} from "../_lib/accounts/preferences/service";
import { createRequestLogger } from "../_lib/core/logging/logger";

interface Env {
  DB?: D1Database;
  OPENAUTH_ISSUER_URL?: string;
  OPENAUTH_CLIENT_ID?: string;
  OPENAUTH_AUDIENCE?: string;
  OPENAUTH_BFF_ORIGIN?: string;
  OPENAUTH_AUTHORITY?: Fetcher;
}

const jsonError = (status: number, code: string, error: string): Response =>
  new Response(JSON.stringify({ error, code }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const handleError = (error: unknown, logger: ReturnType<typeof createRequestLogger>): Response => {
  if (error instanceof AccountPreferencesError) {
    logger.logEnd(error.status, { reason: error.code });
    return jsonError(error.status, error.code, error.message);
  }
  logger.logError("account_preferences.unhandled_error", error);
  logger.logEnd(500, { reason: "unhandled_error" });
  return jsonError(500, "unhandled_error", "Failed to process account preferences.");
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const logger = createRequestLogger({ request, env, route: "/api/account/preferences" });
  logger.logStart();
  try {
    const response = await readAccountPreferencesResponse(env, request);
    logger.logEnd(response.status);
    return response;
  } catch (error) {
    return handleError(error, logger);
  }
};

export const onRequestPatch: PagesFunction<Env> = async ({ request, env }) => {
  const logger = createRequestLogger({ request, env, route: "/api/account/preferences" });
  logger.logStart();
  try {
    const response = await updateAccountPreferenceResponse(env, request);
    logger.logEnd(response.status);
    return response;
  } catch (error) {
    return handleError(error, logger);
  }
};

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method === "GET") return onRequestGet(context);
  if (context.request.method === "PATCH") return onRequestPatch(context);
  return new Response("Method Not Allowed", { status: 405 });
};

import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import { createRequestLogger } from "./_lib/logger";
import { storeDrop, type StoreServiceEnv } from "./_lib/storeService";

interface Env extends StoreServiceEnv {
  R2_BUCKET: R2Bucket;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const logger = createRequestLogger({
    request,
    env,
    route: "/api/store",
  });
  logger.logStart();

  return storeDrop({ request, env, logger });
};

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method === "POST") {
    return onRequestPost(context);
  }

  const logger = createRequestLogger({
    request: context.request,
    env: context.env,
    route: "/api/store",
  });

  logger.logStart();
  logger.warn("store.method_not_allowed", {
    attemptedMethod: context.request.method,
  });
  logger.logEnd(405, {
    reason: "method_not_allowed",
  });

  return new Response("Method Not Allowed", { status: 405 });
};

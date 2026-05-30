import type { D1Database, PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import { createRequestLogger } from "./_lib/core/logging/logger";
import {
  createCloudflareBlobStore,
  createCloudflareSqlStore,
} from "./_lib/core/platform/cloudflarePorts";
import { storeDrop, type StoreServiceEnv } from "./_lib/drops/services/storeDrop";

interface Env extends Omit<StoreServiceEnv, "blobs" | "sql"> {
  R2_BUCKET: R2Bucket;
  DB?: D1Database;
}

const createStoreServiceEnv = (env: Env): StoreServiceEnv => ({
  ...env,
  blobs: createCloudflareBlobStore(env.R2_BUCKET),
  sql: createCloudflareSqlStore(env.DB),
});

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const logger = createRequestLogger({
    request,
    env,
    route: "/api/store",
  });
  logger.logStart();

  return storeDrop({ request, env: createStoreServiceEnv(env), logger });
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

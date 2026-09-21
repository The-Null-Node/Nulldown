/*
`/api/get/:id` resolves the short-link alias namespace and streams back the canonical
drop object from R2. The read path stays deliberately thin so the browser can decide
how to interpret plaintext payloads versus sealed envelopes.
*/

import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { createRequestLogger, toLogRef } from "../_lib/core/logging/logger";
import {
  createCloudflareBlobStore,
  createCloudflareSqlStore,
} from "../_lib/core/platform/cloudflare/storage";
import {
  getRootDrop,
  type GetRootDropServiceEnv,
} from "../_lib/drops/services/get-root-drop";

interface Env {
  R2_BUCKET: R2Bucket;
  DB?: D1Database;
  ACCOUNT_AUTH_SECRET?: string;
  ALLOW_INSECURE_ACCOUNT_HEADER?: string;
}

const READ_SUCCESS_SAMPLE_RATE = 0.1;

const createGetRootDropEnv = (env: Env): GetRootDropServiceEnv => ({
  blobs: createCloudflareBlobStore(env.R2_BUCKET),
  sql: createCloudflareSqlStore(env.DB),
  ACCOUNT_AUTH_SECRET: env.ACCOUNT_AUTH_SECRET,
  ALLOW_INSECURE_ACCOUNT_HEADER: env.ALLOW_INSECURE_ACCOUNT_HEADER,
});

export const onRequestGet: PagesFunction<Env, "id"> = async ({
  env,
  params,
  request,
}) => {
  const logger = createRequestLogger({
    request,
    env,
    route: "/api/get/:id",
    successSampleRate: READ_SUCCESS_SAMPLE_RATE,
  });

  const requestedId =
    typeof params.id === "string" ? params.id : params.id?.[0] ?? "";

  logger.logStart({
    requestedDropRef: toLogRef(requestedId),
  });

  return getRootDrop({
    request,
    requestedId,
    env: createGetRootDropEnv(env),
    logger,
  });
};

export const onRequest: PagesFunction<Env, "id"> = async (context) => {
  if (context.request.method === "GET") {
    return onRequestGet(context);
  }

  const logger = createRequestLogger({
    request: context.request,
    env: context.env,
    route: "/api/get/:id",
    successSampleRate: READ_SUCCESS_SAMPLE_RATE,
  });

  logger.logStart();
  logger.warn("get.method_not_allowed", {
    attemptedMethod: context.request.method,
  });
  logger.logEnd(405, {
    reason: "method_not_allowed",
  });

  return new Response("Method Not Allowed", { status: 405 });
};

import type {
  D1Database,
  PagesFunction,
  R2Bucket,
} from "@cloudflare/workers-types";
import { methodNotAllowedResponse } from "../_lib/core/http/responses";
import { createRequestLogger } from "../_lib/core/logging/logger";
import { createCloudflareBackendRuntime } from "../_lib/core/platform/cloudflare-backend-runtime";
import {
  createCloudflareBlobStore,
  createCloudflareSqlStore,
} from "../_lib/core/platform/cloudflare-storage-adapters";
import {
  pollDiffEvents,
  postDiffEvents,
  type DiffTransportEnv,
} from "../_lib/diffs/transport/service";

interface Env extends Omit<DiffTransportEnv, "R2_BUCKET" | "DB"> {
  R2_BUCKET: R2Bucket;
  DB?: D1Database;
}

export const onRequest: PagesFunction<Env, "id"> = async (context) => {
  const serviceEnv: DiffTransportEnv = {
    ...context.env,
    R2_BUCKET: createCloudflareBlobStore(context.env.R2_BUCKET),
    DB: createCloudflareSqlStore(context.env.DB),
  };
  if (context.request.method === "POST") {
    const runtime = createCloudflareBackendRuntime(context.env);
    return postDiffEvents(serviceEnv, context.params, context.request, {
      serverRuntime: runtime.serverRuntime,
      waitUntil: context.waitUntil?.bind(context),
    });
  }

  if (context.request.method === "GET") {
    return pollDiffEvents(serviceEnv, context.params, context.request);
  }

  const logger = createRequestLogger({
    request: context.request,
    env: context.env,
    route: "/api/diff/:id",
  });

  logger.logStart();
  logger.logEnd(405, {
    reason: "method_not_allowed",
    attemptedMethod: context.request.method,
  });

  return methodNotAllowedResponse();
};

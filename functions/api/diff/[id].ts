import type {
  D1Database,
  PagesFunction,
  R2Bucket,
} from "@cloudflare/workers-types";
import { methodNotAllowedResponse } from "../_lib/core/http/responses";
import { createRequestLogger } from "../_lib/core/logging/logger";
import {
  createTiming,
  observeStore,
  type TelemetryOptions,
} from "../_lib/core/observability/profiling";
import { createCloudflareBackendRuntime } from "../_lib/core/platform/cloudflare/runtime/composition";
import {
  createCloudflareBlobStore,
  createCloudflareSqlStore,
} from "../_lib/core/platform/cloudflare/storage";
import {
  pollDiffEvents,
  postDiffEvents,
  type DiffTransportEnv,
} from "../_lib/diffs/transport/service";

interface Env
  extends Omit<DiffTransportEnv, "R2_BUCKET" | "DB">, TelemetryOptions {
  R2_BUCKET: R2Bucket;
  DB?: D1Database;
}

export const onRequest: PagesFunction<Env, "id"> = async (context) => {
  // Instrument only the selected diff POST, never authentication endpoints.
  const trace = createTiming(
    context.request,
    context.request.method === "POST" ? context.env : {},
    context.waitUntil?.bind(context),
    "request.diff",
  );
  const serviceEnv: DiffTransportEnv = {
    ...context.env,
    R2_BUCKET: createCloudflareBlobStore(context.env.R2_BUCKET),
    DB: createCloudflareSqlStore(context.env.DB),
  };
  serviceEnv.R2_BUCKET = observeStore(serviceEnv.R2_BUCKET, trace.timing, "r2");
  if (serviceEnv.DB)
    serviceEnv.DB = observeStore(serviceEnv.DB, trace.timing, "sql");
  if (context.request.method === "POST") {
    const bindings = {
      ...context.env,
      R2_BUCKET: observeStore(context.env.R2_BUCKET, trace.timing, "r2"),
      DB: context.env.DB
        ? observeStore(context.env.DB, trace.timing, "sql")
        : undefined,
    };
    const runtime = createCloudflareBackendRuntime(bindings, trace.timing);
    let status = 500;
    try {
      const response = await postDiffEvents(
        serviceEnv,
        context.params,
        context.request,
        {
          serverRuntime: runtime.serverRuntime,
          waitUntil: context.waitUntil?.bind(context),
        },
        trace.timing,
      );
      status = response.status;
      return response;
    } finally {
      trace.finish(status);
    }
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

import type {
  D1Database,
  PagesFunction,
  R2Bucket,
} from "@cloudflare/workers-types";
import { getBranchContent } from "../../../_lib/branches/http/read";
import type { BranchRouteEnv } from "../../../_lib/branches/http/request-context";
import { createCloudflareStorageServiceEnv } from "../../../_lib/core/platform/cloudflare/storage";
import {
  createTiming,
  observeStore,
  type TelemetryOptions,
} from "../../../_lib/core/observability/profiling";

interface Env
  extends Omit<BranchRouteEnv, "R2_BUCKET" | "DB">, TelemetryOptions {
  R2_BUCKET: R2Bucket;
  DB?: D1Database;
}

export const onRequestGet: PagesFunction<Env, "rootId" | "branchId"> = async (
  context,
) => {
  const trace = createTiming(
    context.request,
    context.env,
    context.waitUntil?.bind(context),
    "request.content",
  );
  const env = createCloudflareStorageServiceEnv(context.env);
  env.R2_BUCKET = observeStore(env.R2_BUCKET, trace.timing, "r2");
  if (env.DB) env.DB = observeStore(env.DB, trace.timing, "sql");
  let status = 500;
  try {
    const response = await getBranchContent(
      env,
      context.params,
      context.request,
      trace.timing,
    );
    status = response.status;
    return response;
  } finally {
    trace.finish(status);
  }
};

export const onRequest: PagesFunction<Env, "rootId" | "branchId"> = async (
  context,
) => {
  if (context.request.method === "GET") {
    return onRequestGet(context);
  }

  return new Response("Method Not Allowed", { status: 405 });
};

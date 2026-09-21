import type {
  D1Database,
  PagesFunction,
  R2Bucket,
} from "@cloudflare/workers-types";
import { listBranchesForDrop } from "../_lib/branches/http/list";
import type { BranchRouteEnv } from "../_lib/branches/http/request-context";
import { createCloudflareStorageServiceEnv } from "../_lib/core/platform/cloudflare/storage";

interface Env extends Omit<BranchRouteEnv, "R2_BUCKET" | "DB"> {
  R2_BUCKET: R2Bucket;
  DB?: D1Database;
}

export const onRequestGet: PagesFunction<Env, "id"> = ({
  request,
  env,
  params,
}) =>
  listBranchesForDrop(createCloudflareStorageServiceEnv(env), params, request);

export const onRequest: PagesFunction<Env, "id"> = async (context) => {
  if (context.request.method === "GET") {
    return onRequestGet(context);
  }

  return new Response("Method Not Allowed", { status: 405 });
};

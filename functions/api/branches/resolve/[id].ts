import type {
  D1Database,
  PagesFunction,
  R2Bucket,
} from "@cloudflare/workers-types";
import { resolveBranchForRequest } from "../../_lib/branches/http/resolve";
import type { BranchRouteEnv } from "../../_lib/branches/http/request-context";
import { createCloudflareStorageServiceEnv } from "../../_lib/core/platform/cloudflare/storage";

interface Env extends Omit<BranchRouteEnv, "R2_BUCKET" | "DB"> {
  R2_BUCKET: R2Bucket;
  DB?: D1Database;
  PROVIDER_ENCRYPTION_PRIVATE_JWK?: string;
}

export const onRequestPost: PagesFunction<Env, "id"> = async ({
  env,
  params,
  request,
}) =>
  resolveBranchForRequest(
    createCloudflareStorageServiceEnv(env),
    params,
    request,
  );

export const onRequest: PagesFunction<Env, "id"> = async (context) => {
  if (context.request.method === "POST") {
    return onRequestPost(context);
  }

  return new Response("Method Not Allowed", { status: 405 });
};

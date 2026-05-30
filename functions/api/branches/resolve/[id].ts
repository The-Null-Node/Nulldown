import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import {
  resolveBranchForRequest,
  type BranchRouteEnv,
} from "../../_lib/branches/services/routeService";

interface Env extends BranchRouteEnv {
  R2_BUCKET: R2Bucket;
  PROVIDER_ENCRYPTION_PRIVATE_JWK?: string;
}

export const onRequestPost: PagesFunction<Env, "id"> = async ({
  env,
  params,
  request,
}) => resolveBranchForRequest(env, params, request);

export const onRequest: PagesFunction<Env, "id"> = async (context) => {
  if (context.request.method === "POST") {
    return onRequestPost(context);
  }

  return new Response("Method Not Allowed", { status: 405 });
};

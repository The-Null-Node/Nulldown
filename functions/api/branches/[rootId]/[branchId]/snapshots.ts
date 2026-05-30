import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import {
  listBranchSnapshots,
  type BranchRouteEnv,
} from "../../../_lib/branches/services/routeService";

interface Env extends BranchRouteEnv {
  R2_BUCKET: R2Bucket;
}

export const onRequestGet: PagesFunction<Env, "rootId" | "branchId"> = async ({
  env,
  params,
}) => listBranchSnapshots(env, params);

export const onRequest: PagesFunction<Env, "rootId" | "branchId"> = async (
  context,
) => {
  if (context.request.method === "GET") {
    return onRequestGet(context);
  }

  return new Response("Method Not Allowed", { status: 405 });
};

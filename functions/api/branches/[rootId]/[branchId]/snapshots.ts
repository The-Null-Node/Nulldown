import type {
  D1Database,
  PagesFunction,
  R2Bucket,
} from "@cloudflare/workers-types";
import {
  listBranchSnapshots,
  type BranchRouteEnv,
} from "../../../_lib/branches/services/routeService";
import { createCloudflareStorageServiceEnv } from "../../../_lib/core/platform/cloudflarePorts";

interface Env extends Omit<BranchRouteEnv, "R2_BUCKET" | "DB"> {
  R2_BUCKET: R2Bucket;
  DB?: D1Database;
}

export const onRequestGet: PagesFunction<Env, "rootId" | "branchId"> = async ({
  request,
  env,
  params,
}) =>
  listBranchSnapshots(createCloudflareStorageServiceEnv(env), params, request);

export const onRequest: PagesFunction<Env, "rootId" | "branchId"> = async (
  context,
) => {
  if (context.request.method === "GET") {
    return onRequestGet(context);
  }

  return new Response("Method Not Allowed", { status: 405 });
};

import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import {
  backfillBranchesForDrop,
  type BranchRouteEnv,
} from "../../_lib/branchRouteService";
import { methodNotAllowedResponse } from "../../_lib/http";

interface Env extends BranchRouteEnv {
  R2_BUCKET: R2Bucket;
  BRANCH_HEAP_BACKFILL_TOKEN?: string;
}

export const onRequestPost: PagesFunction<Env, "id"> = async ({
  env,
  request,
  params,
}) => backfillBranchesForDrop(env, params, request);

export const onRequest: PagesFunction<Env, "id"> = async (context) => {
  if (context.request.method === "POST") {
    return onRequestPost(context);
  }

  return methodNotAllowedResponse();
};

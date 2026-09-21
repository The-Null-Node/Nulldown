import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import { backfillBranchesForDrop } from "../../_lib/branches/http/backfill";
import type { BranchRouteEnv } from "../../_lib/branches/http/request-context";
import { methodNotAllowedResponse } from "../../_lib/core/http/responses";

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

import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import {
  promoteBranchSnapshot,
  type BranchPromotionEnv,
} from "../../../_lib/branches/services/promotionService";

interface Env extends BranchPromotionEnv {
  R2_BUCKET: R2Bucket;
}

export const onRequestPost: PagesFunction<Env, "rootId" | "branchId"> = async ({
  env,
  params,
  request,
}) => promoteBranchSnapshot(env, params, request);

export const onRequest: PagesFunction<Env, "rootId" | "branchId"> = async (
  context,
) => {
  if (context.request.method === "POST") {
    return onRequestPost(context);
  }

  return new Response("Method Not Allowed", { status: 405 });
};

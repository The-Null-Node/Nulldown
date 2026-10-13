import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import { publishOwnerSnapshot } from "../../../_lib/branches/publication";
import type { BranchPromotionEnv } from "../../../_lib/branches/promotion";

interface Env extends BranchPromotionEnv {
  R2_BUCKET: R2Bucket;
}

/** HTTP adapter for an authenticated same-root owner publication. */
export const onRequest: PagesFunction<Env, "rootId" | "branchId"> = ({
  env,
  params,
  request,
}) =>
  request.method === "POST"
    ? publishOwnerSnapshot(env, params, request)
    : new Response("Method Not Allowed", { status: 405 });

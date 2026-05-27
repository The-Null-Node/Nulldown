import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import {
  updateResolvedHeap,
  type ResolvedHeapEnv,
} from "../../../../_lib/resolvedHeapService";
import { methodNotAllowedResponse } from "../../../../_lib/http";

interface Env extends ResolvedHeapEnv {
  R2_BUCKET: R2Bucket;
}

export const onRequestPost: PagesFunction<Env, "rootId" | "branchId"> = ({
  env,
  params,
  request,
}) => updateResolvedHeap(env, params, request);

export const onRequest: PagesFunction<Env, "rootId" | "branchId"> = async (context) => {
  if (context.request.method === "POST") {
    return onRequestPost(context);
  }

  return methodNotAllowedResponse();
};

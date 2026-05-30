import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import {
  queryResolvedHeap,
  type ResolvedHeapEnv,
} from "../../../../_lib/resolved/heap/service";
import { methodNotAllowedResponse } from "../../../../_lib/core/http/responses";

interface Env extends ResolvedHeapEnv {
  R2_BUCKET: R2Bucket;
}

export const onRequestGet: PagesFunction<Env, "rootId" | "branchId"> = ({
  env,
  params,
  request,
}) => queryResolvedHeap(env, params, request);

export const onRequest: PagesFunction<Env, "rootId" | "branchId"> = async (context) => {
  if (context.request.method === "GET") {
    return onRequestGet(context);
  }

  return methodNotAllowedResponse();
};

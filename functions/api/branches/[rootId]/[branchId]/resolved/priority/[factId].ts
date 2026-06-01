import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import {
  deleteResolvedPriorityFact,
  type ResolvedHeapEnv,
} from "../../../../../_lib/resolved/heap/service";
import { methodNotAllowedResponse } from "../../../../../_lib/core/http/responses";

interface Env extends ResolvedHeapEnv {
  R2_BUCKET: R2Bucket;
}

export const onRequestDelete: PagesFunction<
  Env,
  "rootId" | "branchId" | "factId"
> = ({ env, params, request }) =>
  deleteResolvedPriorityFact(env, params, request);

export const onRequest: PagesFunction<
  Env,
  "rootId" | "branchId" | "factId"
> = async (context) => {
  if (context.request.method === "DELETE") {
    return onRequestDelete(context);
  }

  return methodNotAllowedResponse();
};

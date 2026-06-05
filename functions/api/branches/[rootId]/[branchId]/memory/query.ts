import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import { methodNotAllowedResponse } from "../../../../_lib/core/http/responses";
import { queryNullMem, type NullMemEnv } from "../../../../_lib/nullmem/service";

interface Env extends NullMemEnv {
  R2_BUCKET: R2Bucket;
}

export const onRequestGet: PagesFunction<Env, "rootId" | "branchId"> = ({
  env,
  params,
  request,
}) => queryNullMem(env, params, request);

export const onRequest: PagesFunction<Env, "rootId" | "branchId"> = async (context) => {
  if (context.request.method === "GET") {
    return onRequestGet(context);
  }

  return methodNotAllowedResponse();
};

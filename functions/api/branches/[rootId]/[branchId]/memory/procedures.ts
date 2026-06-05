import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import { methodNotAllowedResponse } from "../../../../_lib/core/http/responses";
import {
  createNullMemProcedure,
  type NullMemEnv,
} from "../../../../_lib/nullmem/service";

interface Env extends NullMemEnv {
  R2_BUCKET: R2Bucket;
}

export const onRequestPost: PagesFunction<Env, "rootId" | "branchId"> = ({
  env,
  params,
  request,
}) => createNullMemProcedure(env, params, request);

export const onRequest: PagesFunction<Env, "rootId" | "branchId"> = async (context) => {
  if (context.request.method === "POST") {
    return onRequestPost(context);
  }

  return methodNotAllowedResponse();
};

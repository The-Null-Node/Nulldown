import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import { createCloudflareBackendRuntime } from "../../../../_lib/core/platform/cloudflareBackendRuntime";
import { methodNotAllowedResponse } from "../../../../_lib/core/http/responses";
import {
  deleteNullMemRecord,
  type NullMemEnv,
} from "../../../../_lib/nullmem/service";

interface Env extends NullMemEnv {
  R2_BUCKET: R2Bucket;
}

export const onRequestDelete: PagesFunction<
  Env,
  "rootId" | "branchId" | "recordId"
> = ({ env, params, request }) => {
  const runtime = createCloudflareBackendRuntime(env);
  return deleteNullMemRecord(env, params, request, { memory: runtime.memory });
};

export const onRequest: PagesFunction<
  Env,
  "rootId" | "branchId" | "recordId"
> = async (context) => {
  if (context.request.method === "DELETE") {
    return onRequestDelete(context);
  }

  return methodNotAllowedResponse();
};

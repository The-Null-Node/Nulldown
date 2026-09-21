import type {
  D1Database,
  PagesFunction,
  R2Bucket,
} from "@cloudflare/workers-types";
import { methodNotAllowedResponse } from "../../../../_lib/core/http/responses";
import { createCloudflareStorageServiceEnv } from "../../../../_lib/core/platform/cloudflare/storage";
import { createCloudflareRuntimeDataStore } from "../../../../_lib/core/platform/cloudflare/runtime-data/store";
import { queryNullMem, type NullMemEnv } from "../../../../_lib/nullmem/http";

interface Env extends Omit<NullMemEnv, "R2_BUCKET" | "DB"> {
  R2_BUCKET: R2Bucket;
  DB?: D1Database;
}

export const onRequestGet: PagesFunction<Env, "rootId" | "branchId"> = ({
  env,
  params,
  request,
}) =>
  queryNullMem(createCloudflareStorageServiceEnv(env), params, request, {
    data: createCloudflareRuntimeDataStore(env),
  });

export const onRequest: PagesFunction<Env, "rootId" | "branchId"> = async (
  context,
) => {
  if (context.request.method === "GET") {
    return onRequestGet(context);
  }

  return methodNotAllowedResponse();
};

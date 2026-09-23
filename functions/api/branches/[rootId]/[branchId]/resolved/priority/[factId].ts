import type {
  D1Database,
  PagesFunction,
  R2Bucket,
} from "@cloudflare/workers-types";
import {
  deleteResolvedPriorityFact,
  type ResolvedHeapEnv,
} from "../../../../../_lib/resolved/heap/service";
import { methodNotAllowedResponse } from "../../../../../_lib/core/http/responses";
import { createCloudflareStorageServiceEnv } from "../../../../../_lib/core/platform/cloudflare/storage";

interface Env extends Omit<ResolvedHeapEnv, "R2_BUCKET" | "DB"> {
  R2_BUCKET: R2Bucket;
  DB?: D1Database;
}

export const onRequestDelete: PagesFunction<
  Env,
  "rootId" | "branchId" | "factId"
> = ({ env, params, request }) =>
  deleteResolvedPriorityFact(
    createCloudflareStorageServiceEnv(env),
    params,
    request,
  );

export const onRequest: PagesFunction<
  Env,
  "rootId" | "branchId" | "factId"
> = async (context) => {
  if (context.request.method === "DELETE") {
    return onRequestDelete(context);
  }

  return methodNotAllowedResponse();
};

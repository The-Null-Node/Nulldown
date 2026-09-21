import type {
  D1Database,
  PagesFunction,
  R2Bucket,
} from "@cloudflare/workers-types";
import {
  createResolvedPriorityFact,
  listResolvedPriorityFacts,
  type ResolvedHeapEnv,
} from "../../../../_lib/resolved/heap/service";
import { methodNotAllowedResponse } from "../../../../_lib/core/http/responses";
import { createCloudflareStorageServiceEnv } from "../../../../_lib/core/platform/cloudflare-storage-adapters";

interface Env extends Omit<ResolvedHeapEnv, "R2_BUCKET" | "DB"> {
  R2_BUCKET: R2Bucket;
  DB?: D1Database;
}

export const onRequestPost: PagesFunction<Env, "rootId" | "branchId"> = ({
  env,
  params,
  request,
}) =>
  createResolvedPriorityFact(
    createCloudflareStorageServiceEnv(env),
    params,
    request,
  );

export const onRequestGet: PagesFunction<Env, "rootId" | "branchId"> = ({
  env,
  params,
  request,
}) =>
  listResolvedPriorityFacts(
    createCloudflareStorageServiceEnv(env),
    params,
    request,
  );

export const onRequest: PagesFunction<Env, "rootId" | "branchId"> = async (
  context,
) => {
  if (context.request.method === "GET") {
    return onRequestGet(context);
  }
  if (context.request.method === "POST") {
    return onRequestPost(context);
  }

  return methodNotAllowedResponse();
};

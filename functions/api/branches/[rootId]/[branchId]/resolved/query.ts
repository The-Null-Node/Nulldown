import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import {
  queryResolvedHeap,
  type ResolvedHeapEnv,
} from "../../../../_lib/resolved/heap/service";
import { methodNotAllowedResponse, jsonResponse } from "../../../../_lib/core/http/responses";
import { createCloudflareBackendRuntime } from "../../../../_lib/core/platform/cloudflareBackendRuntime";
import type { NulleditNextRequest } from "../../../../../src/server/nulledit/types";

interface Env extends ResolvedHeapEnv {
  R2_BUCKET: R2Bucket;
}

const RESOLVED_DOCUMENT_SNAPSHOTTER_ID = "nulledit.resolved-document";

export const onRequestGet: PagesFunction<Env, "rootId" | "branchId"> = ({
  env,
  params,
  request,
}) => {
  const runtime = createCloudflareBackendRuntime(env);
  const url = new URL(request.url);
  const snapshotterId = url.searchParams.get("snapshotterId");

  if (snapshotterId && snapshotterId !== RESOLVED_DOCUMENT_SNAPSHOTTER_ID) {
    const top = url.searchParams.get("k") ? Number(url.searchParams.get("k")) : undefined;
    const maxTokens = url.searchParams.get("maxTokens") ? Number(url.searchParams.get("maxTokens")) : undefined;
    const preview = url.searchParams.get("preview") ? url.searchParams.get("preview") === "true" : undefined;
    const labelsParam = url.searchParams.get("labels");
    const labels = labelsParam ? labelsParam.split(",").filter(Boolean) : undefined;
    const req: NulleditNextRequest = {
      query: url.searchParams.get("q") || url.searchParams.get("query") || undefined,
      top: Number.isFinite(top) ? top : undefined,
      maxTokens: Number.isFinite(maxTokens) ? maxTokens : undefined,
      preview,
      labels,
    };
    const result = runtime.getSnapshotterYieldNext(snapshotterId, req);
    const promise = result instanceof Promise ? result : Promise.resolve(result);
    return promise.then((r) => jsonResponse(r ?? { items: [] }));
  }

  return queryResolvedHeap(env, params, request, {
    repairBufferedCommits: ({ rootDropId, branchId }) =>
      runtime.repairBufferedCommitsForQuery({ rootDropId, branchId }),
  });
};

export const onRequest: PagesFunction<Env, "rootId" | "branchId"> = async (context) => {
  if (context.request.method === "GET") {
    return onRequestGet(context);
  }

  return methodNotAllowedResponse();
};

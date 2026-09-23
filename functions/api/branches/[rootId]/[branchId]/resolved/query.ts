import type {
  D1Database,
  PagesFunction,
  R2Bucket,
} from "@cloudflare/workers-types";
import {
  queryResolvedHeap,
  type ResolvedHeapEnv,
} from "../../../../_lib/resolved/heap/service";
import { methodNotAllowedResponse } from "../../../../_lib/core/http/responses";
import { createCloudflareBackendRuntime } from "../../../../_lib/core/platform/cloudflare/runtime/composition";
import {
  createCloudflareBlobStore,
  createCloudflareSqlStore,
} from "../../../../_lib/core/platform/cloudflare/storage";

interface Env extends Omit<ResolvedHeapEnv, "R2_BUCKET" | "DB"> {
  R2_BUCKET: R2Bucket;
  DB?: D1Database;
}

export const onRequestGet: PagesFunction<Env, "rootId" | "branchId"> = ({
  env,
  params,
  request,
}) => {
  let runtime: ReturnType<typeof createCloudflareBackendRuntime> | undefined;
  const getRuntime = () => (runtime ??= createCloudflareBackendRuntime(env));
  const serviceEnv: ResolvedHeapEnv = {
    ...env,
    R2_BUCKET: createCloudflareBlobStore(env.R2_BUCKET),
    DB: createCloudflareSqlStore(env.DB),
    resolvedDocumentData: getRuntime().data,
  };

  return queryResolvedHeap(serviceEnv, params, request, {
    repairBufferedCommits: ({ rootDropId, branchId }) =>
      getRuntime().repairBufferedCommitsForQuery({ rootDropId, branchId }),
    querySnapshotter: (snapshotterId, snapshotterRequest) =>
      getRuntime().getSnapshotterYieldNext(snapshotterId, snapshotterRequest),
  });
};

export const onRequest: PagesFunction<Env, "rootId" | "branchId"> = async (
  context,
) => {
  if (context.request.method === "GET") {
    return onRequestGet(context);
  }

  return methodNotAllowedResponse();
};

import type {
  D1Database,
  PagesFunction,
  R2Bucket,
} from "@cloudflare/workers-types";
import { createCloudflareBackendRuntime } from "../../../../_lib/core/platform/cloudflare-backend-runtime";
import {
  createCloudflareBlobStore,
  createCloudflareSqlStore,
} from "../../../../_lib/core/platform/cloudflare-storage-adapters";
import { methodNotAllowedResponse } from "../../../../_lib/core/http/responses";
import {
  deleteNullMemRecord,
  type NullMemEnv,
} from "../../../../_lib/nullmem/service";

interface Env extends Omit<NullMemEnv, "R2_BUCKET" | "DB"> {
  R2_BUCKET: R2Bucket;
  DB?: D1Database;
}

export const onRequestDelete: PagesFunction<
  Env,
  "rootId" | "branchId" | "recordId"
> = ({ env, params, request }) => {
  const runtime = createCloudflareBackendRuntime(env);
  return deleteNullMemRecord(
    {
      ...env,
      R2_BUCKET: createCloudflareBlobStore(env.R2_BUCKET),
      DB: createCloudflareSqlStore(env.DB),
    },
    params,
    request,
    { memory: runtime.memory },
  );
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

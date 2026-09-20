import type {
  D1Database,
  PagesFunction,
  R2Bucket,
} from "@cloudflare/workers-types";
import { createCloudflareBackendRuntime } from "../../../../_lib/core/platform/cloudflare-backend-runtime";
import {
  createCloudflareBlobStore,
  createCloudflareSqlStore,
} from "../../../../_lib/core/platform/cloudflarePorts";
import { methodNotAllowedResponse } from "../../../../_lib/core/http/responses";
import {
  createNullMemProcedure,
  type NullMemEnv,
} from "../../../../_lib/nullmem/service";

interface Env extends Omit<NullMemEnv, "R2_BUCKET" | "DB"> {
  R2_BUCKET: R2Bucket;
  DB?: D1Database;
}

export const onRequestPost: PagesFunction<Env, "rootId" | "branchId"> = ({
  env,
  params,
  request,
}) => {
  const runtime = createCloudflareBackendRuntime(env);
  return createNullMemProcedure(
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

export const onRequest: PagesFunction<Env, "rootId" | "branchId"> = async (
  context,
) => {
  if (context.request.method === "POST") {
    return onRequestPost(context);
  }

  return methodNotAllowedResponse();
};

import type { D1Database, PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import {
  backfillD1Metadata,
  type MetadataBackfillEnv,
} from "../_lib/core/d1/backfillService";
import { methodNotAllowedResponse } from "../_lib/core/http/responses";
import { createRequestLogger } from "../_lib/core/logging/logger";

interface Env extends MetadataBackfillEnv {
  R2_BUCKET: R2Bucket;
  DB?: D1Database;
}

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const logger = createRequestLogger({
    request,
    env,
    route: "/api/metadata/backfill",
  });
  logger.logStart();

  const response = await backfillD1Metadata(env, request, logger);
  logger.logEnd(response.status);
  return response;
};

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method === "POST") {
    return onRequestPost(context);
  }

  return methodNotAllowedResponse();
};

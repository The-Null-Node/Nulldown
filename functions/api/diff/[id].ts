import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import {
  methodNotAllowedResponse,
} from "../_lib/http";
import { createRequestLogger } from "../_lib/logger";
import {
  pollDiffEvents,
  postDiffEvents,
  type DiffTransportEnv,
} from "../_lib/diffTransportService";

interface Env extends DiffTransportEnv {
  R2_BUCKET: R2Bucket;
}

export const onRequest: PagesFunction<Env, "id"> = async (context) => {
  if (context.request.method === "POST") {
    return postDiffEvents(
      context.env,
      context.params,
      context.request,
      context.waitUntil?.bind(context),
    );
  }

  if (context.request.method === "GET") {
    return pollDiffEvents(context.env, context.params, context.request);
  }

  const logger = createRequestLogger({
    request: context.request,
    env: context.env,
    route: "/api/diff/:id",
  });

  logger.logStart();
  logger.logEnd(405, {
    reason: "method_not_allowed",
    attemptedMethod: context.request.method,
  });

  return methodNotAllowedResponse();
};

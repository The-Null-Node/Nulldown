import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import { resolveRemoteDropId } from "../_lib/dropId";
import { createRequestLogger, toLogRef } from "../_lib/logger";

interface Env {
  R2_BUCKET: R2Bucket;
}

const resolveId = (id: string | string[] | undefined) =>
  typeof id === "string" ? id : Array.isArray(id) ? id[0] : "";

export const onRequestDelete: PagesFunction<Env, "id"> = async ({
  env,
  params,
  request,
}) => {
  const logger = createRequestLogger({
    request,
    env,
    route: "/api/delete/:id",
  });

  const requestedId = resolveId(params.id);

  logger.logStart({
    requestedDropRef: toLogRef(requestedId),
  });

  try {
    if (!env.R2_BUCKET) {
      logger.error("delete.bucket_binding_missing", {
        requestedDropRef: toLogRef(requestedId),
      });
      logger.logEnd(500, {
        reason: "bucket_binding_missing",
        requestedDropRef: toLogRef(requestedId),
      });
      return new Response("R2 bucket binding is required.", { status: 500 });
    }

    const id = await resolveRemoteDropId(env.R2_BUCKET, requestedId, logger);

    if (!id) {
      logger.warn("delete.invalid_drop_id", {
        requestedDropRef: toLogRef(requestedId),
      });
      logger.logEnd(400, {
        reason: "invalid_drop_id",
        requestedDropRef: toLogRef(requestedId),
      });
      return new Response("Drop ID is required.", { status: 400 });
    }

    await env.R2_BUCKET.delete(id);

    logger.logEnd(204, {
      requestedDropRef: toLogRef(requestedId),
      canonicalDropRef: toLogRef(id),
    });

    return new Response(null, { status: 204 });
  } catch (error: unknown) {
    logger.logError("delete.unhandled_error", error, {
      requestedDropRef: toLogRef(requestedId),
    });
    const message = error instanceof Error ? error.message : String(error);
    logger.logEnd(500, {
      reason: "unhandled_error",
      requestedDropRef: toLogRef(requestedId),
    });
    return new Response(`Failed to delete drop: ${message}`, { status: 500 });
  }
};

export const onRequest: PagesFunction<Env, "id"> = async (context) => {
  if (context.request.method === "DELETE") {
    return onRequestDelete(context);
  }

  const logger = createRequestLogger({
    request: context.request,
    env: context.env,
    route: "/api/delete/:id",
  });

  logger.logStart();
  logger.warn("delete.method_not_allowed", {
    attemptedMethod: context.request.method,
  });
  logger.logEnd(405, {
    reason: "method_not_allowed",
  });

  return new Response("Method Not Allowed", { status: 405 });
};

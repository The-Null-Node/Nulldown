import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import { removePublicDropIndexEntry } from "../_lib/dropIndex";
import { removeRemoteAliasIfMatch, resolveRemoteDropId } from "../_lib/dropId";
import { createRequestLogger, toLogRef } from "../_lib/logger";

interface Env {
  R2_BUCKET: R2Bucket;
}

const jsonErrorResponse = (
  status: number,
  code: string,
  error: string,
  details?: Record<string, unknown>,
): Response =>
  new Response(
    JSON.stringify({
      error,
      code,
      details,
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
      },
    },
  );

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
      return jsonErrorResponse(
        500,
        "bucket_binding_missing",
        "R2 bucket binding is required.",
      );
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
      return jsonErrorResponse(400, "invalid_drop_id", "Drop ID is required.");
    }

    const expectedRevisionHeader = request.headers.get("If-Match")?.trim() || null;
    if (expectedRevisionHeader) {
      const object = await env.R2_BUCKET.get(id);
      if (!object) {
        logger.logEnd(404, {
          reason: "drop_not_found",
          requestedDropRef: toLogRef(requestedId),
          canonicalDropRef: toLogRef(id),
        });
        return jsonErrorResponse(404, "drop_not_found", "Drop not found.", {
          requestedDropRef: toLogRef(requestedId),
          canonicalDropRef: toLogRef(id),
        });
      }

      if (object.httpEtag !== expectedRevisionHeader) {
        logger.warn("delete.revision_precondition_failed", {
          requestedDropRef: toLogRef(requestedId),
          canonicalDropRef: toLogRef(id),
        });
        logger.logEnd(412, {
          reason: "revision_precondition_failed",
          requestedDropRef: toLogRef(requestedId),
          canonicalDropRef: toLogRef(id),
        });
        return jsonErrorResponse(
          412,
          "revision_precondition_failed",
          "Drop revision precondition failed. Refresh and try again.",
          {
            requestedDropRef: toLogRef(requestedId),
            canonicalDropRef: toLogRef(id),
          },
        );
      }
    }

    await env.R2_BUCKET.delete(id);
    await Promise.all([
      removeRemoteAliasIfMatch(env.R2_BUCKET, id, logger),
      removePublicDropIndexEntry(env.R2_BUCKET, id),
    ]);

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
    return jsonErrorResponse(
      500,
      "unhandled_error",
      `Failed to delete drop: ${message}`,
    );
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

import { R2Bucket } from "@cloudflare/workers-types";
import { resolveRemoteDropId } from "../_lib/dropId";
import { createRequestLogger, toLogRef } from "../_lib/logger";

// Define the expected shape of the environment variables
interface Env {
  R2_BUCKET: R2Bucket; // R2 Bucket Binding (set in Cloudflare Pages dashboard)
}

const READ_SUCCESS_SAMPLE_RATE = 0.1;

// Basic validation for required environment variables
function validateEnv(env: Env): void {
  if (!env.R2_BUCKET)
    throw new Error(
      "R2_BUCKET binding is required. Configure in Cloudflare Pages > Settings > Functions > R2 bucket bindings",
    );
}

export const onRequestGet: PagesFunction<Env, "id"> = async ({
  env,
  params,
  request,
}) => {
  const copyHeaders = (headers: Headers, object: R2Object) => {
    Object.entries(object.httpMetadata || {}).forEach(([key, value]) => {
      headers.set(key, value as string);
    });
  };

  const logger = createRequestLogger({
    request,
    env,
    route: "/api/get/:id",
    successSampleRate: READ_SUCCESS_SAMPLE_RATE,
  });

  const requestedId =
    typeof params.id === "string" ? params.id : params.id?.[0] ?? "";

  logger.logStart({
    requestedDropRef: toLogRef(requestedId),
  });

  try {
    validateEnv(env);

    const id = await resolveRemoteDropId(env.R2_BUCKET, requestedId, logger);

    if (!id) {
      logger.warn("get.invalid_drop_id", {
        requestedDropRef: toLogRef(requestedId),
      });
      logger.logEnd(400, {
        reason: "invalid_drop_id",
        requestedDropRef: toLogRef(requestedId),
      });
      return new Response("Drop ID is required.", { status: 400 });
    }

    const canonicalDropRef = toLogRef(id);

    const object = await env.R2_BUCKET.get(id);

    if (object === null) {
      logger.warn("get.drop_not_found", {
        requestedDropRef: toLogRef(requestedId),
        canonicalDropRef,
      });
      logger.logEnd(404, {
        reason: "drop_not_found",
        requestedDropRef: toLogRef(requestedId),
        canonicalDropRef,
      });
      return new Response("Drop not found.", { status: 404 });
    }

    const headers = new Headers({
      "Content-Type": object.httpMetadata?.contentType || "text/plain",
      ETag: object.httpEtag,
      "X-Drop-Canonical-Id": id,
    });

    copyHeaders(headers, object);

    logger.logEnd(200, {
      requestedDropRef: toLogRef(requestedId),
      canonicalDropRef,
      contentType: object.httpMetadata?.contentType || "text/plain",
    });

    return new Response(object.body, {
      status: 200,
      headers: headers,
    });
  } catch (error: unknown) {
    logger.logError("get.unhandled_error", error, {
      requestedDropRef: toLogRef(requestedId),
    });
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.logEnd(500, {
      reason: "unhandled_error",
      requestedDropRef: toLogRef(requestedId),
    });
    return new Response(`Failed to retrieve drop: ${errorMessage}`, {
      status: 500,
    });
  }
};

// Fallback for other methods or if only onRequestGet is defined for this route file
export const onRequest: PagesFunction<Env, "id"> = async (context) => {
  if (context.request.method === "GET") {
    return onRequestGet(context);
  }

  const logger = createRequestLogger({
    request: context.request,
    env: context.env,
    route: "/api/get/:id",
    successSampleRate: READ_SUCCESS_SAMPLE_RATE,
  });

  logger.logStart();
  logger.warn("get.method_not_allowed", {
    attemptedMethod: context.request.method,
  });
  logger.logEnd(405, {
    reason: "method_not_allowed",
  });

  return new Response("Method Not Allowed", { status: 405 });
};

/*
 `/api/nullplug/submit` stores atomic UI responses as immutable facts. Proposed diffs
 stay data until a separate policy grant accepts them into branch diffs.
*/

import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import {
  isNullplugUiResponseFact,
  nullplugUiResponseFactKey,
  type NullplugUiResponseFact,
} from "../../../shared/nullplug/ui";
import { resolveRemoteDropId } from "../_lib/dropId";
import { createRequestLogger, toLogRef } from "../_lib/logger";
import {
  jsonErrorResponse,
  jsonResponse,
  methodNotAllowedResponse,
  readRequestTextWithLimit,
} from "../_lib/http";

interface Env {
  R2_BUCKET: R2Bucket;
}

const NULLPLUG_SUBMIT_BODY_MAX_BYTES = 512_000;

const parseResponseFact = (rawBody: string): NullplugUiResponseFact | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }

  return isNullplugUiResponseFact(parsed) ? parsed : null;
};

const handlePost = async (env: Env, request: Request): Promise<Response> => {
  const logger = createRequestLogger({
    request,
    env,
    route: "/api/nullplug/submit",
  });
  logger.logStart();

  try {
    if (!env.R2_BUCKET) {
      logger.logEnd(500, { reason: "bucket_missing" });
      return new Response("R2 bucket binding is required.", { status: 500 });
    }

    const rawBody = await readRequestTextWithLimit(
      request,
      NULLPLUG_SUBMIT_BODY_MAX_BYTES,
    );
    const parsed = parseResponseFact(rawBody);
    if (!parsed) {
      logger.logEnd(400, { reason: "invalid_response_fact" });
      return jsonErrorResponse(
        400,
        "validation_failed",
        "Invalid nullplug UI response fact.",
      );
    }

    const canonicalRootDropId = await resolveRemoteDropId(
      env.R2_BUCKET,
      parsed.source.rootDropId,
      logger,
    );
    if (!canonicalRootDropId) {
      logger.logEnd(404, {
        reason: "root_drop_not_found",
        rootDropRef: toLogRef(parsed.source.rootDropId),
      });
      return jsonErrorResponse(404, "root_drop_not_found", "Root drop not found.");
    }

    if (!(await env.R2_BUCKET.get(canonicalRootDropId))) {
      logger.logEnd(404, {
        reason: "root_drop_not_found",
        rootDropRef: toLogRef(canonicalRootDropId),
      });
      return jsonErrorResponse(404, "root_drop_not_found", "Root drop not found.");
    }

    const fact: NullplugUiResponseFact = {
      ...parsed,
      source: {
        ...parsed.source,
        rootDropId: canonicalRootDropId,
      },
    };
    const key = nullplugUiResponseFactKey(fact);
    const written = await env.R2_BUCKET.put(key, JSON.stringify(fact), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagDoesNotMatch: "*" },
    });

    if (!written) {
      logger.logEnd(409, {
        reason: "response_fact_exists",
        rootDropRef: toLogRef(canonicalRootDropId),
      });
      return jsonErrorResponse(
        409,
        "response_fact_exists",
        "Response fact already exists.",
      );
    }

    logger.logEnd(200, {
      rootDropRef: toLogRef(canonicalRootDropId),
      branchRef: toLogRef(fact.source.branchId),
      primitiveId: fact.primitiveId,
    });
    return jsonResponse({ stored: true, key, fact });
  } catch (error) {
    logger.logError("nullplug.submit.unhandled_error", error);
    logger.logEnd(500, { reason: "unhandled_error" });
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Failed to submit nullplug response: ${message}`, {
      status: 500,
    });
  }
};

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method === "POST") {
    return handlePost(context.env, context.request);
  }

  return methodNotAllowedResponse();
};

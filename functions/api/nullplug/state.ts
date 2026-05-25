/*
 `/api/nullplug/state` stores nullplug-owned UI state facts. These records are
 durable inputs for resolved runtime heaps; they do not directly mutate branch content.
*/

import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import {
  isNullplugUiStatePatchFact,
  isNullplugUiStateSnapshot,
  nullplugUiStatePatchFactKey,
  nullplugUiStateSnapshotKey,
  type NullplugUiStatePatchFact,
  type NullplugUiStateSnapshot,
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

type NullplugUiStateFact = NullplugUiStatePatchFact | NullplugUiStateSnapshot;

const NULLPLUG_STATE_BODY_MAX_BYTES = 512_000;

const parseStateFact = (rawBody: string): NullplugUiStateFact | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }

  if (isNullplugUiStatePatchFact(parsed)) return parsed;
  if (isNullplugUiStateSnapshot(parsed)) return parsed;
  return null;
};

const keyForFact = (fact: NullplugUiStateFact): string =>
  fact.kind === "ui.state.patch"
    ? nullplugUiStatePatchFactKey(fact)
    : nullplugUiStateSnapshotKey(fact);

const handlePost = async (env: Env, request: Request): Promise<Response> => {
  const logger = createRequestLogger({
    request,
    env,
    route: "/api/nullplug/state",
  });
  logger.logStart();

  try {
    if (!env.R2_BUCKET) {
      logger.logEnd(500, { reason: "bucket_missing" });
      return new Response("R2 bucket binding is required.", { status: 500 });
    }

    const rawBody = await readRequestTextWithLimit(
      request,
      NULLPLUG_STATE_BODY_MAX_BYTES,
    );
    const parsed = parseStateFact(rawBody);
    if (!parsed) {
      logger.logEnd(400, { reason: "invalid_state_fact" });
      return jsonErrorResponse(
        400,
        "validation_failed",
        "Invalid nullplug UI state fact.",
      );
    }

    const canonicalRootDropId = await resolveRemoteDropId(
      env.R2_BUCKET,
      parsed.source.rootDropId,
      logger,
    );
    if (!canonicalRootDropId || !(await env.R2_BUCKET.get(canonicalRootDropId))) {
      logger.logEnd(404, {
        reason: "root_drop_not_found",
        rootDropRef: toLogRef(parsed.source.rootDropId),
      });
      return jsonErrorResponse(404, "root_drop_not_found", "Root drop not found.");
    }

    const fact: NullplugUiStateFact = {
      ...parsed,
      source: {
        ...parsed.source,
        rootDropId: canonicalRootDropId,
      },
    };
    const key = keyForFact(fact);
    const written = await env.R2_BUCKET.put(key, JSON.stringify(fact), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagDoesNotMatch: "*" },
    });

    if (!written) {
      logger.logEnd(409, {
        reason: "state_fact_exists",
        rootDropRef: toLogRef(canonicalRootDropId),
      });
      return jsonErrorResponse(
        409,
        "state_fact_exists",
        "State fact already exists.",
      );
    }

    logger.logEnd(200, {
      rootDropRef: toLogRef(canonicalRootDropId),
      branchRef: toLogRef(fact.source.branchId),
      callId: fact.callId,
      kind: fact.kind,
    });
    return jsonResponse({ stored: true, key, fact });
  } catch (error) {
    logger.logError("nullplug.state.unhandled_error", error);
    logger.logEnd(500, { reason: "unhandled_error" });
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Failed to store nullplug state: ${message}`, {
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

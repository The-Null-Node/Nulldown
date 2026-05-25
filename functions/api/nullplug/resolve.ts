/*
 `/api/nullplug/resolve` is the explicit provider runtime boundary for built-in
 nullplug resolution. First pass supports trusted `nd` resolution only; remote plugin
 manifests and arbitrary imports are intentionally out of scope.
*/

import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import {
  isNullplugInvokeRequest,
  type NullplugInvokeRequest,
  type NullplugInvokeResponse,
} from "../../../shared/nullplug/types";
import { toShortDropId } from "../../../shared/drop/id";
import {
  isDropEnvelopeV1,
  isDropPayload,
  type DropPayload,
} from "../../../shared/drop/types";
import { resolveRemoteDropId } from "../_lib/dropId";
import { decryptProviderEscrowEnvelope } from "../_lib/providerEscrow";
import { createRequestLogger, toLogRef } from "../_lib/logger";
import {
  jsonErrorResponse,
  jsonResponse,
  methodNotAllowedResponse,
  readRequestTextWithLimit,
} from "../_lib/http";

interface Env {
  R2_BUCKET: R2Bucket;
  PROVIDER_ENCRYPTION_PRIVATE_JWK?: string;
}

const NULLPLUG_RESOLVE_BODY_MAX_BYTES = 256_000;

const parseInvokeRequest = (rawBody: string): NullplugInvokeRequest | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }

  return isNullplugInvokeRequest(parsed) ? parsed : null;
};

const readText = async (
  object: { text: () => Promise<string> } | null,
): Promise<string | null> => {
  if (!object) return null;
  try {
    return await object.text();
  } catch {
    return null;
  }
};

const readProviderDropPayload = async (
  bucket: R2Bucket,
  dropId: string,
  providerPrivateKey?: string,
): Promise<DropPayload | null> => {
  const raw = await readText(await bucket.get(dropId));
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { content: raw };
  }

  if (isDropPayload(parsed)) {
    return parsed;
  }

  if (isDropEnvelopeV1(parsed) && providerPrivateKey) {
    try {
      return await decryptProviderEscrowEnvelope(parsed, providerPrivateKey);
    } catch {
      return null;
    }
  }

  return null;
};

const firstStringArg = (
  request: NullplugInvokeRequest,
  key: string,
): string | null => {
  const value = request.call.args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const firstBodyLine = (value: string | undefined): string | null => {
  if (!value) return null;
  const first = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return first ?? null;
};

const extractTitle = (content: string): string => {
  const heading = content
    .split(/\r?\n/)
    .map((line) => /^\s{0,3}#\s+(.+?)\s*#*\s*$/.exec(line)?.[1]?.trim())
    .find((line): line is string => Boolean(line));
  return heading ?? "Nulldown Drop";
};

const extractExcerpt = (content: string): string => {
  const excerpt = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return excerpt.length > 180 ? `${excerpt.slice(0, 177)}...` : excerpt;
};

const escapeMarkdownLinkText = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");

const resolveNd = async (
  env: Env,
  request: NullplugInvokeRequest,
): Promise<Response> => {
  const target = firstStringArg(request, "id") ?? firstBodyLine(request.call.body);
  if (!target) {
    return jsonErrorResponse(
      400,
      "missing_target",
      "nd resolver requires args.id or a body drop id.",
    );
  }

  const resolvedDropId = await resolveRemoteDropId(env.R2_BUCKET, target);
  if (!resolvedDropId) {
    return jsonErrorResponse(404, "drop_not_found", "Drop not found.");
  }

  const payload = await readProviderDropPayload(
    env.R2_BUCKET,
    resolvedDropId,
    env.PROVIDER_ENCRYPTION_PRIVATE_JWK,
  );
  if (!payload) {
    return jsonErrorResponse(
      403,
      "drop_unreadable",
      "Provider could not read the requested drop.",
    );
  }

  const title = extractTitle(payload.content);
  const excerpt = extractExcerpt(payload.content);
  const shortId = toShortDropId(resolvedDropId);
  const response: NullplugInvokeResponse = {
    result: {
      content: [`### [${escapeMarkdownLinkText(title)}](/d/${shortId})`, excerpt]
        .filter(Boolean)
        .join("\n\n"),
      metadata: {
        pluginId: "nd",
        resolvedDropId,
        shortId,
        title,
        excerpt,
      },
    },
    diagnostics: [
      {
        level: "info",
        message: "Resolved built-in nd nullplug through provider runtime.",
      },
    ],
  };

  return jsonResponse(response);
};

const handlePost = async (env: Env, request: Request): Promise<Response> => {
  const logger = createRequestLogger({
    request,
    env,
    route: "/api/nullplug/resolve",
  });
  logger.logStart();

  try {
    if (!env.R2_BUCKET) {
      logger.logEnd(500, { reason: "bucket_missing" });
      return new Response("R2 bucket binding is required.", { status: 500 });
    }

    const rawBody = await readRequestTextWithLimit(
      request,
      NULLPLUG_RESOLVE_BODY_MAX_BYTES,
    );
    const parsed = parseInvokeRequest(rawBody);
    if (!parsed) {
      logger.logEnd(400, { reason: "invalid_invoke_request" });
      return jsonErrorResponse(
        400,
        "validation_failed",
        "Invalid nullplug invoke request.",
      );
    }

    if (parsed.call.pluginId !== "nd") {
      logger.logEnd(400, {
        reason: "unsupported_plugin",
        pluginId: parsed.call.pluginId,
      });
      return jsonErrorResponse(
        400,
        "unsupported_plugin",
        "Provider resolver currently supports the built-in nd plugin only.",
      );
    }

    const response = await resolveNd(env, parsed);
    logger.logEnd(response.status, {
      pluginId: parsed.call.pluginId,
      callerDropRef: toLogRef(parsed.call.caller.dropId),
    });
    return response;
  } catch (error) {
    logger.logError("nullplug.resolve.unhandled_error", error);
    logger.logEnd(500, { reason: "unhandled_error" });
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Failed to resolve nullplug: ${message}`, { status: 500 });
  }
};

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method === "POST") {
    return handlePost(context.env, context.request);
  }

  return methodNotAllowedResponse();
};

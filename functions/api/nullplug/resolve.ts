import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import {
  isNullplugInvokeRequest,
  type NullplugInvokeRequest,
} from "../../../shared/nullplug/types";
import {
  isNullplugRuntimeError,
  type NullplugRuntimeError,
} from "../../../shared/nullplug/runtime";
import { createCloudflareBackendRuntime } from "../_lib/core/platform/cloudflareBackendRuntime";
import { resolveAuthenticatedAccountId } from "../_lib/accounts/session/auth";
import { createBranchRepository } from "../_lib/branches/storage/repository";
import { sanitizeDiffAuthToken } from "../_lib/diffs/credentials/repository";
import { createDropIdentityRepository } from "../_lib/drops/identity/id";
import { createRequestLogger, toLogRef } from "../_lib/core/logging/logger";
import {
  jsonErrorResponse,
  jsonResponse,
  methodNotAllowedResponse,
  readRequestTextWithLimit,
} from "../_lib/core/http/responses";

interface Env {
  R2_BUCKET: R2Bucket;
  DB?: D1Database;
  PROVIDER_ENCRYPTION_PRIVATE_JWK?: string;
  NULLPLUG_REGISTRY_ALLOWED_HOSTS?: string;
  ACCOUNT_AUTH_SECRET?: string;
  ACCOUNT_AUTH_TOKEN_TTL_MS?: string;
  ALLOW_INSECURE_ACCOUNT_HEADER?: string;
  fetchImpl?: typeof fetch;
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

const runtimeErrorStatus = (error: NullplugRuntimeError): number => {
  if (error.code === "drop_not_found") return 404;
  if (error.code === "unsupported_plugin") return 404;
  if (
    error.code === "drop_unreadable" ||
    error.code === "policy_denied" ||
    error.code === "policy_conditional" ||
    error.code === "policy_source_required" ||
    error.code === "policy_source_unreadable" ||
    error.code === "invalid_root_policy"
  ) {
    return 403;
  }
  if (error.code === "missing_target" || error.code === "caller_mismatch") {
    return 400;
  }
  return 502;
};

const authorizeCallerBranch = async (
  env: Env,
  request: Request,
  invokeRequest: NullplugInvokeRequest,
): Promise<Response | null> => {
  const accountId = await resolveAuthenticatedAccountId(request, env);
  if (!accountId) {
    return jsonErrorResponse(
      401,
      "account_required",
      "Authenticated account session is required.",
    );
  }

  const requestedRootDropId =
    invokeRequest.call.caller.dropId ?? invokeRequest.context.callerDropId;
  const branchId = sanitizeDiffAuthToken(
    invokeRequest.call.caller.branchId ?? invokeRequest.context.branchId ?? "",
  );
  if (!requestedRootDropId || !branchId) {
    return jsonErrorResponse(
      400,
      "caller_branch_required",
      "Remote nullplug invocation requires an active caller branch.",
    );
  }

  const identities = createDropIdentityRepository({
    blobs: env.R2_BUCKET,
    sql: env.DB,
  });
  const rootDropId = await identities.resolveRemoteDropId(requestedRootDropId);
  if (!rootDropId) {
    return jsonErrorResponse(404, "caller_root_not_found", "Caller root not found.");
  }

  const branch = await createBranchRepository({
    blobs: env.R2_BUCKET,
    sql: env.DB,
  }).readBranch(rootDropId, branchId);
  if (!branch) {
    return jsonErrorResponse(404, "caller_branch_not_found", "Caller branch not found.");
  }
  if (
    accountId !== branch.ownerAccountId &&
    accountId !== branch.writerAccountId
  ) {
    return jsonErrorResponse(
      403,
      "caller_branch_forbidden",
      "You are not allowed to invoke nullplugs for this caller branch.",
    );
  }
  if (branch.status !== "active") {
    return jsonErrorResponse(
      409,
      "caller_branch_not_active",
      "Remote nullplug invocation requires an active caller branch.",
    );
  }

  return null;
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

    const authorizationError = await authorizeCallerBranch(env, request, parsed);
    if (authorizationError) {
      logger.logEnd(authorizationError.status, { reason: "caller_unauthorized" });
      return authorizationError;
    }

    const runtime = createCloudflareBackendRuntime(env);
    const response = await runtime.voidProvider.nullplug.invoke(parsed);
    logger.logEnd(200, {
      pluginId: parsed.call.pluginId,
      callerDropRef: toLogRef(parsed.call.caller.dropId),
    });
    return jsonResponse(response);
  } catch (error) {
    if (isNullplugRuntimeError(error)) {
      const status = runtimeErrorStatus(error);
      logger.logEnd(status, { reason: error.code });
      return jsonErrorResponse(status, error.code, error.message);
    }

    logger.logError("nullplug.resolve.unhandled_error", error);
    logger.logEnd(500, { reason: "unhandled_error" });
    return jsonErrorResponse(
      500,
      "resolve_failed",
      "Failed to resolve nullplug.",
    );
  }
};

const handleRequest = async (context: {
  request: Request;
  env: Env;
}): Promise<Response> => {
  if (context.request.method === "POST") {
    return handlePost(context.env, context.request);
  }
  return methodNotAllowedResponse();
};

export const onRequest = handleRequest;

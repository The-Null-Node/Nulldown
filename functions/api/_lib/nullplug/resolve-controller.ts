import {
  isNullplugInvokeRequest,
  type NullplugInvokeRequest,
} from "../../../../shared/nullplug/types";
import {
  isNullplugRuntimeError,
  type NullplugRuntime,
  type NullplugRuntimeError,
} from "../../../../shared/nullplug/runtime";
import { resolveAuthenticatedAccountId } from "../accounts/session/authentication";
import { createBranchRepository } from "../branches/storage/repository";
import { sanitizeDiffAuthToken } from "../diffs/credentials/repository";
import { createDropIdentityRepository } from "../drops/identity/id";
import { createRequestLogger, toLogRef } from "../core/logging/logger";
import {
  canReadSensitiveBranch,
  resolveRootReadAuthorization,
  type RootReadAuthorizationPorts,
} from "../security/read-authorization";
import type { BlobObjectStore } from "../../../../src/server/ports";
import {
  jsonErrorResponse,
  jsonResponse,
  methodNotAllowedResponse,
  readRequestTextWithLimit,
} from "../core/http/responses";

/** Portable storage and auth ports used by the Nullplug resolve controller. */
export interface NullplugResolveControllerEnv extends RootReadAuthorizationPorts {
  R2_BUCKET: BlobObjectStore;
}

/** Authorized caller context used to construct a request-scoped Nullplug runtime. */
export interface AuthorizedNullplugCaller {
  accountId: string;
  rootDropId: string;
}

/** Runtime factory invoked only after the caller branch is authorized. */
export type NullplugResolveRuntimeFactory = (input: {
  request: Request;
  caller: AuthorizedNullplugCaller;
}) => NullplugRuntime;

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

type CallerAuthorizationResult =
  { authorized: AuthorizedNullplugCaller } | { error: Response };

const callerRootNotFoundResponse = (): Response =>
  jsonErrorResponse(404, "caller_root_not_found", "Caller root not found.");

const authorizeCallerBranch = async (
  env: NullplugResolveControllerEnv,
  request: Request,
  invokeRequest: NullplugInvokeRequest,
): Promise<CallerAuthorizationResult> => {
  const requestedRootDropId =
    invokeRequest.call.caller.dropId ?? invokeRequest.context.callerDropId;
  const branchId = sanitizeDiffAuthToken(
    invokeRequest.call.caller.branchId ?? invokeRequest.context.branchId ?? "",
  );
  if (!requestedRootDropId || !branchId) {
    return {
      error: jsonErrorResponse(
        400,
        "caller_branch_required",
        "Remote nullplug invocation requires an active caller branch.",
      ),
    };
  }

  const identities = createDropIdentityRepository({
    blobs: env.R2_BUCKET,
    sql: env.DB,
  });
  const rootDropId =
    await identities.resolveRemoteDropIdForReadRequest(requestedRootDropId);
  if (!rootDropId) {
    return { error: callerRootNotFoundResponse() };
  }

  const rootAuthorization = await resolveRootReadAuthorization(
    request,
    env,
    rootDropId,
  );
  if (rootAuthorization.kind === "denied") {
    return { error: callerRootNotFoundResponse() };
  }

  const accountId = await resolveAuthenticatedAccountId(request, env);
  if (!accountId) {
    return {
      error: jsonErrorResponse(
        401,
        "account_required",
        "Authenticated account session is required.",
      ),
    };
  }

  const branch = await createBranchRepository({
    blobs: env.R2_BUCKET,
    sql: env.DB,
  }).readBranch(rootDropId, branchId);
  if (!branch) {
    return {
      error:
        rootAuthorization.kind === "private" &&
        !rootAuthorization.isCanonicalOwner
          ? callerRootNotFoundResponse()
          : jsonErrorResponse(
              404,
              "caller_branch_not_found",
              "Caller branch not found.",
            ),
    };
  }
  if (!(await canReadSensitiveBranch(request, env, rootDropId, branch))) {
    return {
      error:
        rootAuthorization.kind === "private"
          ? callerRootNotFoundResponse()
          : jsonErrorResponse(
              403,
              "caller_branch_forbidden",
              "You are not allowed to invoke nullplugs for this caller branch.",
            ),
    };
  }
  if (branch.status !== "active") {
    return {
      error: jsonErrorResponse(
        409,
        "caller_branch_not_active",
        "Remote nullplug invocation requires an active caller branch.",
      ),
    };
  }

  return { authorized: { accountId, rootDropId } };
};

const handlePost = async (
  env: NullplugResolveControllerEnv,
  request: Request,
  createRuntime: NullplugResolveRuntimeFactory,
): Promise<Response> => {
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

    const authorization = await authorizeCallerBranch(env, request, parsed);
    if ("error" in authorization) {
      logger.logEnd(authorization.error.status, {
        reason: "caller_unauthorized",
      });
      return authorization.error;
    }

    const runtime = createRuntime({
      request,
      caller: authorization.authorized,
    });
    const response = await runtime.invoke(parsed);
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

/** Handles the portable HTTP contract for authorized Nullplug invocation. */
export const handleNullplugResolveRequest = async (context: {
  request: Request;
  env: NullplugResolveControllerEnv;
  createRuntime: NullplugResolveRuntimeFactory;
}): Promise<Response> => {
  if (context.request.method === "POST") {
    return handlePost(context.env, context.request, context.createRuntime);
  }
  return methodNotAllowedResponse();
};

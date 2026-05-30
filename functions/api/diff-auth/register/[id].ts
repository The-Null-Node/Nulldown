import type { D1Database, PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import {
  DIFF_AUTH_DEFAULT_TTL_MS,
  generateDiffSecret,
  putDiffAuthCredential,
  sanitizeDiffAuthToken,
} from "../../_lib/diffs/credentials/repository";
import {
  resolveAuthenticatedAccountId,
  type AccountAuthEnv,
} from "../../_lib/accounts/session/auth";
import { resolveBranchForActor } from "../../_lib/branches/lifecycle/service";
import { resolveRemoteDropId } from "../../_lib/drops/identity/id";
import { createRequestLogger, serializeError, toLogRef } from "../../_lib/core/logging/logger";
import type {
  DiffAuthRegisterRequest,
  DiffAuthRegisterResponse,
} from "../../../../shared/drop/diffAuth";
import { serverVoidCrypto } from "../../_lib/crypto/void/serverVoidCrypto";

interface Env extends AccountAuthEnv {
  R2_BUCKET: R2Bucket;
  DB?: D1Database;
  DIFF_AUTH_TTL_MS?: string;
  PROVIDER_ENCRYPTION_PRIVATE_JWK?: string;
}

const resolveId = (id: string | string[] | undefined) =>
  typeof id === "string" ? id : Array.isArray(id) ? id[0] : "";

const resolveTtlMs = (rawTtl: string | undefined): number => {
  if (!rawTtl) {
    return DIFF_AUTH_DEFAULT_TTL_MS;
  }

  const parsed = Number.parseInt(rawTtl, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DIFF_AUTH_DEFAULT_TTL_MS;
  }

  return parsed;
};

export const onRequestPost: PagesFunction<Env, "id"> = async ({
  env,
  params,
  request,
}) => {
  const logger = createRequestLogger({
    request,
    env,
    route: "/api/diff-auth/register/:id",
  });

  const requestedId = resolveId(params.id);

  logger.logStart({
    requestedDropRef: toLogRef(requestedId),
  });

  try {
    if (!env.R2_BUCKET) {
      logger.logEnd(500, { reason: "bucket_missing" });
      return new Response("R2 bucket binding is required.", { status: 500 });
    }

    const id = await resolveRemoteDropId(env.R2_BUCKET, requestedId, logger, env.DB);
    if (!id) {
      logger.logEnd(400, { reason: "invalid_drop_id" });
      return new Response("Drop ID is required.", { status: 400 });
    }

    const dropObject = await env.R2_BUCKET.get(id);
    if (!dropObject) {
      logger.logEnd(404, {
        reason: "drop_not_found",
        dropRef: toLogRef(id),
      });
      return new Response("Drop not found.", { status: 404 });
    }

    let body: DiffAuthRegisterRequest;

    try {
      body = (await request.json()) as DiffAuthRegisterRequest;
    } catch {
      logger.logEnd(400, { reason: "invalid_json", dropRef: toLogRef(id) });
      return new Response("Invalid JSON payload.", { status: 400 });
    }

    if (!body.requesterPublicJwk) {
      logger.logEnd(400, {
        reason: "requester_public_key_missing",
        dropRef: toLogRef(id),
      });
      return new Response("requesterPublicJwk is required.", { status: 400 });
    }

    const clientId =
      sanitizeDiffAuthToken(body.clientId) ??
      `client_${typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Date.now().toString(36)}`;
    const accountId = await resolveAuthenticatedAccountId(request, env);
    if (!accountId) {
      logger.logEnd(401, {
        reason: "unauthenticated_account",
        dropRef: toLogRef(id),
      });
      return new Response("Authenticated account session is required.", {
        status: 401,
      });
    }
    const { branch } = await resolveBranchForActor(
      env.R2_BUCKET,
      id,
      accountId,
      clientId,
      env.PROVIDER_ENCRYPTION_PRIVATE_JWK,
      env.DB,
    );
    const kid =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `kid_${Date.now().toString(36)}`;
    const ttlMs = resolveTtlMs(env.DIFF_AUTH_TTL_MS);
    const createdAt = Date.now();
    const expiresAt = createdAt + ttlMs;

    let wrappedSecret: string;
    const secret = generateDiffSecret();

    try {
      wrappedSecret = await serverVoidCrypto.wrapTextForRequester(
        body.requesterPublicJwk,
        secret,
      );
    } catch (error) {
      logger.logEnd(400, {
        reason: "requester_public_key_invalid",
        dropRef: toLogRef(id),
        error: serializeError(error),
      });
      return new Response("requesterPublicJwk is invalid.", { status: 400 });
    }

    await putDiffAuthCredential(
      env.R2_BUCKET,
      {
        version: 1,
        dropId: id,
        branchId: branch.branchId,
        clientId,
        kid,
        secret,
        createdAt,
        expiresAt,
      },
      env.DB,
    );

    const responseBody: DiffAuthRegisterResponse = {
      dropId: id,
      branchId: branch.branchId,
      clientId,
      kid,
      wrappedSecret,
      expiresAt,
    };

    logger.logEnd(200, {
      dropRef: toLogRef(id),
      branchRef: toLogRef(branch.branchId),
      clientIdRef: toLogRef(clientId),
      kidRef: toLogRef(kid),
      expiresAt,
    });

    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error: unknown) {
    logger.logError("diff_auth.register.unhandled_error", error, {
      requestedDropRef: toLogRef(requestedId),
    });
    logger.logEnd(500, {
      reason: "unhandled_error",
      requestedDropRef: toLogRef(requestedId),
    });
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Failed to register diff auth: ${message}`, {
      status: 500,
    });
  }
};

export const onRequest: PagesFunction<Env, "id"> = async (context) => {
  if (context.request.method === "POST") {
    return onRequestPost(context);
  }

  const logger = createRequestLogger({
    request: context.request,
    env: context.env,
    route: "/api/diff-auth/register/:id",
  });

  logger.logStart();
  logger.logEnd(405, {
    reason: "method_not_allowed",
    attemptedMethod: context.request.method,
  });

  return new Response("Method Not Allowed", { status: 405 });
};

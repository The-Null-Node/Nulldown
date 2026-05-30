import type { D1Database, PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import { isDropEnvelopeV1 } from "../../../shared/drop/types";
import { resolveRemoteDropId } from "../_lib/drops/identity/id";
import { createRequestLogger, serializeError, toLogRef } from "../_lib/core/logging/logger";
import { serverVoidCrypto } from "../_lib/crypto/void/serverVoidCrypto";

interface Env {
  R2_BUCKET: R2Bucket;
  DB?: D1Database;
  PROVIDER_ENCRYPTION_PRIVATE_JWK?: string;
}

interface UnlockRequestBody {
  requesterPublicJwk?: JsonWebKey;
}

const resolveId = (id: string | string[] | undefined) =>
  typeof id === "string" ? id : Array.isArray(id) ? id[0] : "";

export const onRequestPost: PagesFunction<Env, "id"> = async ({
  env,
  params,
  request,
}) => {
  const logger = createRequestLogger({
    request,
    env,
    route: "/api/unlock/:id",
  });

  const requestedId = resolveId(params.id);

  logger.logStart({
    requestedDropRef: toLogRef(requestedId),
  });

  try {
    if (!env.R2_BUCKET) {
      logger.error("unlock.bucket_binding_missing", {
        requestedDropRef: toLogRef(requestedId),
      });
      logger.logEnd(500, {
        reason: "bucket_binding_missing",
        requestedDropRef: toLogRef(requestedId),
      });
      return new Response("R2 bucket binding is required.", { status: 500 });
    }

    if (!env.PROVIDER_ENCRYPTION_PRIVATE_JWK) {
      logger.error("unlock.provider_key_missing", {
        requestedDropRef: toLogRef(requestedId),
      });
      logger.logEnd(501, {
        reason: "provider_key_missing",
        requestedDropRef: toLogRef(requestedId),
      });
      return new Response("Provider escrow key is not configured.", {
        status: 501,
      });
    }

    const id = await resolveRemoteDropId(env.R2_BUCKET, requestedId, logger, env.DB);
    if (!id) {
      logger.warn("unlock.invalid_drop_id", {
        requestedDropRef: toLogRef(requestedId),
      });
      logger.logEnd(400, {
        reason: "invalid_drop_id",
        requestedDropRef: toLogRef(requestedId),
      });
      return new Response("Drop ID is required.", { status: 400 });
    }

    const canonicalDropRef = toLogRef(id);

    let body: UnlockRequestBody;

    try {
      body = (await request.json()) as UnlockRequestBody;
    } catch {
      logger.warn("unlock.invalid_json", {
        requestedDropRef: toLogRef(requestedId),
        canonicalDropRef,
      });
      logger.logEnd(400, {
        reason: "invalid_json",
        requestedDropRef: toLogRef(requestedId),
        canonicalDropRef,
      });
      return new Response("Invalid JSON payload.", { status: 400 });
    }

    if (!body.requesterPublicJwk) {
      logger.warn("unlock.requester_public_key_missing", {
        requestedDropRef: toLogRef(requestedId),
        canonicalDropRef,
      });
      logger.logEnd(400, {
        reason: "requester_public_key_missing",
        requestedDropRef: toLogRef(requestedId),
        canonicalDropRef,
      });
      return new Response("requesterPublicJwk is required.", { status: 400 });
    }

    const object = await env.R2_BUCKET.get(id);
    if (!object) {
      logger.warn("unlock.drop_not_found", {
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

    const serialized = await new Response(object.body).text();
    let parsed: unknown;

    try {
      parsed = JSON.parse(serialized);
    } catch {
      logger.warn("unlock.stored_payload_not_json", {
        requestedDropRef: toLogRef(requestedId),
        canonicalDropRef,
      });
      logger.logEnd(400, {
        reason: "stored_payload_not_json",
        requestedDropRef: toLogRef(requestedId),
        canonicalDropRef,
      });
      return new Response("Drop payload is not JSON.", { status: 400 });
    }

    if (!isDropEnvelopeV1(parsed)) {
      logger.warn("unlock.stored_payload_not_envelope", {
        requestedDropRef: toLogRef(requestedId),
        canonicalDropRef,
      });
      logger.logEnd(400, {
        reason: "stored_payload_not_envelope",
        requestedDropRef: toLogRef(requestedId),
        canonicalDropRef,
      });
      return new Response("Drop payload is not an encrypted envelope.", {
        status: 400,
      });
    }

    if (parsed.unlockPolicy !== "provider-escrow" || !parsed.providerEscrow) {
      logger.warn("unlock.policy_forbidden", {
        requestedDropRef: toLogRef(requestedId),
        canonicalDropRef,
        unlockPolicy: parsed.unlockPolicy,
        hasProviderEscrow: Boolean(parsed.providerEscrow),
      });
      logger.logEnd(403, {
        reason: "policy_forbidden",
        requestedDropRef: toLogRef(requestedId),
        canonicalDropRef,
        unlockPolicy: parsed.unlockPolicy,
      });
      return new Response("Drop does not allow provider escrow unlock.", {
        status: 403,
      });
    }

    let providerPrivateKey: CryptoKey;

    try {
      providerPrivateKey = await serverVoidCrypto.importProviderPrivateKey(
        env.PROVIDER_ENCRYPTION_PRIVATE_JWK,
      );
    } catch (error) {
      logger.error("unlock.provider_key_invalid", {
        requestedDropRef: toLogRef(requestedId),
        canonicalDropRef,
        error: serializeError(error),
      });
      logger.logEnd(500, {
        reason: "provider_key_invalid",
        requestedDropRef: toLogRef(requestedId),
        canonicalDropRef,
      });
      return new Response("Provider escrow key is invalid.", { status: 500 });
    }

    let requesterPublicKey: CryptoKey;

    try {
      requesterPublicKey = await serverVoidCrypto.importRequesterPublicKey(
        body.requesterPublicJwk,
      );
    } catch (error) {
      logger.warn("unlock.requester_public_key_invalid", {
        requestedDropRef: toLogRef(requestedId),
        canonicalDropRef,
        error: serializeError(error),
      });
      logger.logEnd(400, {
        reason: "requester_public_key_invalid",
        requestedDropRef: toLogRef(requestedId),
        canonicalDropRef,
      });
      return new Response("requesterPublicJwk is invalid.", { status: 400 });
    }

    const rawContentKey = await serverVoidCrypto.decryptProviderWrappedContentKey(
      providerPrivateKey,
      parsed.providerEscrow.wrappedKey,
    );

    const requesterWrappedKey =
      await serverVoidCrypto.wrapRawContentKeyWithRequesterPublicKey(
        requesterPublicKey,
        rawContentKey,
      );

    logger.logEnd(200, {
      requestedDropRef: toLogRef(requestedId),
      canonicalDropRef,
      unlockPolicy: parsed.unlockPolicy,
    });

    return new Response(
      JSON.stringify({
        wrappedKey: requesterWrappedKey,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error: unknown) {
    logger.logError("unlock.unhandled_error", error, {
      requestedDropRef: toLogRef(requestedId),
    });
    const message = error instanceof Error ? error.message : String(error);
    logger.logEnd(500, {
      reason: "unhandled_error",
      requestedDropRef: toLogRef(requestedId),
    });
    return new Response(`Failed to unlock drop: ${message}`, { status: 500 });
  }
};

export const onRequest: PagesFunction<Env, "id"> = async (context) => {
  if (context.request.method === "POST") {
    return onRequestPost(context);
  }

  const logger = createRequestLogger({
    request: context.request,
    env: context.env,
    route: "/api/unlock/:id",
  });

  logger.logStart();
  logger.warn("unlock.method_not_allowed", {
    attemptedMethod: context.request.method,
  });
  logger.logEnd(405, {
    reason: "method_not_allowed",
  });

  return new Response("Method Not Allowed", { status: 405 });
};

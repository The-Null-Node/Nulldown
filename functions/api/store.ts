import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import {
  DROP_ID_LENGTH,
  generateDropId,
  isDropIdToken,
  toShortDropId,
} from "../../shared/drop/id";
import {
  isDropEnvelopeV1,
  isDropPayload,
  serializeDropEnvelopeForProviderSignature,
  type DropEnvelopeV1,
} from "../../shared/drop/types";
import {
  removeRemoteAliasIfMatch,
  reserveRemoteAlias,
} from "./_lib/dropId";
import {
  createRequestLogger,
  serializeError,
  toLogRef,
  type RequestLogger,
} from "./_lib/logger";

interface Env {
  R2_BUCKET: R2Bucket;
  PUBLIC_BASE_URL: string;
  PROVIDER_SIGNING_PRIVATE_JWK?: string;
}

interface StoreRequestBody {
  id?: string;
  upsert?: boolean;
  envelope?: unknown;
}

const textEncoder = new TextEncoder();
const MAX_ID_ALLOCATION_ATTEMPTS = 64;

const toBase64 = (value: ArrayBuffer): string => {
  const bytes = new Uint8Array(value);
  let binary = "";

  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary);
};

const sanitizeDropId = (value: string | undefined): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!isDropIdToken(trimmed)) {
    return null;
  }

  if (trimmed.length < DROP_ID_LENGTH || trimmed.length > 120) {
    return null;
  }

  return trimmed;
};

const putDropObject = async (
  bucket: R2Bucket,
  id: string,
  payload: string,
  contentType: string,
  upsert: boolean,
): Promise<boolean> => {
  if (upsert) {
    await bucket.put(id, payload, {
      httpMetadata: { contentType },
    });
    return true;
  }

  const created = await bucket.put(id, payload, {
    onlyIf: {
      etagDoesNotMatch: "*",
    },
    httpMetadata: { contentType },
  });

  return Boolean(created);
};

const signProviderEnvelope = async (
  envelope: DropEnvelopeV1,
  env: Env,
  logger: RequestLogger,
): Promise<DropEnvelopeV1> => {
  const rawProviderKey = env.PROVIDER_SIGNING_PRIVATE_JWK;
  if (!rawProviderKey) {
    return envelope;
  }

  let jwk: JsonWebKey;

  try {
    jwk = JSON.parse(rawProviderKey) as JsonWebKey;
  } catch (error) {
    logger.error("store.provider_signing_key_invalid_json", {
      error: serializeError(error),
    });
    return envelope;
  }

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    false,
    ["sign"],
  );

  const signedPayload = serializeDropEnvelopeForProviderSignature(envelope);
  const signature = await crypto.subtle.sign(
    {
      name: "ECDSA",
      hash: "SHA-256",
    },
    key,
    textEncoder.encode(signedPayload),
  );

  const keyIdSource = jwk as unknown as Record<string, unknown>;
  const keyId = typeof keyIdSource.kid === "string" ? keyIdSource.kid : "provider";

  logger.debug("store.provider_signature_applied", {
    providerKeyId: keyId,
  });

  return {
    ...envelope,
    signatures: {
      ...envelope.signatures,
      provider: {
        kid: keyId,
        alg: "ECDSA_P256_SHA256",
        sig: toBase64(signature),
      },
    },
  };
};

function validateEnv(env: Env): void {
  if (!env.R2_BUCKET)
    throw new Error(
      "R2_BUCKET binding is required. Configure in Cloudflare Pages > Settings > Functions > R2 bucket bindings",
    );
  if (!env.PUBLIC_BASE_URL)
    throw new Error(
      "PUBLIC_BASE_URL environment variable is required. Set in Cloudflare Pages > Settings > Environment variables",
    );
}

const parseStoreRequest = (parsed: unknown) => {
  if (typeof parsed !== "object" || parsed === null) {
    return { id: null as string | null, upsert: false, payload: parsed };
  }

  const body = parsed as StoreRequestBody;
  if (body.envelope !== undefined) {
    return {
      id: sanitizeDropId(body.id),
      upsert: Boolean(body.upsert),
      payload: body.envelope,
    };
  }

  return {
    id: sanitizeDropId(body.id),
    upsert: Boolean(body.upsert),
    payload: parsed,
  };
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const logger = createRequestLogger({
    request,
    env,
    route: "/api/store",
  });
  logger.logStart();

  try {
    validateEnv(env);

    const contentType = request.headers.get("Content-Type") || "";
    const isJson = contentType.includes("application/json");
    const rawBody = await request.text();
    let storedPayload = rawBody;
    let storedContentType = isJson ? "application/json" : "text/plain";
    let requestedId: string | null = null;
    let upsert = false;
    let payloadKind: "plain_text" | "drop_payload" | "drop_envelope" =
      "plain_text";
    let allocationAttempts = 0;
    let aliasConflictCount = 0;
    let objectConflictCount = 0;

    if (isJson) {
      let parsed: unknown;

      try {
        parsed = JSON.parse(rawBody);
      } catch {
        logger.warn("store.invalid_json", {
          contentType,
        });
        logger.logEnd(400, {
          reason: "invalid_json",
        });
        return new Response("Invalid JSON payload.", { status: 400 });
      }

      const parsedRequest = parseStoreRequest(parsed);
      requestedId = parsedRequest.id;
      upsert = parsedRequest.upsert;

      if (isDropEnvelopeV1(parsedRequest.payload)) {
        payloadKind = "drop_envelope";
        const signedEnvelope = await signProviderEnvelope(
          parsedRequest.payload,
          env,
          logger,
        );
        storedPayload = JSON.stringify(signedEnvelope);
      } else if (isDropPayload(parsedRequest.payload)) {
        payloadKind = "drop_payload";

        if (!parsedRequest.payload.content.trim()) {
          logger.warn("store.empty_payload_content", {
            requestedDropRef: toLogRef(requestedId),
          });
          logger.logEnd(400, {
            reason: "empty_payload_content",
            requestedDropRef: toLogRef(requestedId),
          });
          return new Response("Request body cannot be empty.", { status: 400 });
        }

        storedPayload = JSON.stringify({
          content: parsedRequest.payload.content,
          metadata: parsedRequest.payload.metadata || {},
          draftPack: parsedRequest.payload.draftPack,
        });
      } else {
        logger.warn("store.unsupported_payload", {
          requestedDropRef: toLogRef(requestedId),
        });
        logger.logEnd(400, {
          reason: "unsupported_payload",
          requestedDropRef: toLogRef(requestedId),
        });
        return new Response(
          "Unsupported JSON payload. Expected a drop payload or encrypted drop envelope.",
          { status: 400 },
        );
      }
    } else if (!rawBody.trim()) {
      logger.warn("store.empty_plain_text_body");
      logger.logEnd(400, {
        reason: "empty_plain_text_body",
      });
      return new Response("Request body cannot be empty.", { status: 400 });
    }

    let id: string | null = null;

    if (requestedId) {
      allocationAttempts = 1;
      const aliasState = await reserveRemoteAlias(env.R2_BUCKET, requestedId, logger);
      if (aliasState === "conflict") {
        aliasConflictCount += 1;
        logger.warn("store.alias_conflict", {
          requestedDropRef: toLogRef(requestedId),
        });
        logger.logEnd(409, {
          reason: "alias_conflict",
          requestedDropRef: toLogRef(requestedId),
        });
        return new Response("Drop short link is already in use.", { status: 409 });
      }

      let stored = false;

      try {
        stored = await putDropObject(
          env.R2_BUCKET,
          requestedId,
          storedPayload,
          storedContentType,
          upsert,
        );
      } catch (error) {
        if (aliasState === "reserved") {
          await removeRemoteAliasIfMatch(env.R2_BUCKET, requestedId, logger);
        }

        throw error;
      }

      if (!stored) {
        objectConflictCount += 1;
        logger.warn("store.object_conflict", {
          requestedDropRef: toLogRef(requestedId),
          upsert,
        });
        logger.logEnd(409, {
          reason: "object_conflict",
          requestedDropRef: toLogRef(requestedId),
          upsert,
        });
        return new Response("Drop ID already exists.", { status: 409 });
      }

      id = requestedId;
    } else {
      for (let attempt = 0; attempt < MAX_ID_ALLOCATION_ATTEMPTS; attempt += 1) {
        allocationAttempts = attempt + 1;
        const candidateId = generateDropId(DROP_ID_LENGTH);
        const aliasState = await reserveRemoteAlias(env.R2_BUCKET, candidateId, logger);
        if (aliasState === "conflict") {
          aliasConflictCount += 1;
          continue;
        }

        let stored = false;

        try {
          stored = await putDropObject(
            env.R2_BUCKET,
            candidateId,
            storedPayload,
            storedContentType,
            false,
          );
        } catch (error) {
          if (aliasState === "reserved") {
            await removeRemoteAliasIfMatch(env.R2_BUCKET, candidateId, logger);
          }

          throw error;
        }

        if (stored) {
          id = candidateId;
          break;
        }

        objectConflictCount += 1;
        if (aliasState === "reserved") {
          await removeRemoteAliasIfMatch(env.R2_BUCKET, candidateId, logger);
        }
      }
    }

    if (!id) {
      logger.error("store.id_allocation_failed", {
        attempts: allocationAttempts,
        aliasConflictCount,
        objectConflictCount,
      });
      logger.logEnd(500, {
        reason: "id_allocation_failed",
        attempts: allocationAttempts,
        aliasConflictCount,
        objectConflictCount,
      });
      return new Response("Failed to allocate a unique drop ID.", { status: 500 });
    }

    const baseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, "");
    const dropUrl = `${baseUrl}/d/${toShortDropId(id)}`;

    logger.logEnd(200, {
      dropRef: toLogRef(id),
      requestedDropRef: toLogRef(requestedId),
      upsert,
      payloadKind,
      attempts: allocationAttempts,
      aliasConflictCount,
      objectConflictCount,
    });

    return new Response(JSON.stringify({ id, url: dropUrl }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    logger.logError("store.unhandled_error", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.logEnd(500, {
      reason: "unhandled_error",
    });
    return new Response(`Failed to store drop: ${errorMessage}`, {
      status: 500,
    });
  }
};

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method === "POST") {
    return onRequestPost(context);
  }

  const logger = createRequestLogger({
    request: context.request,
    env: context.env,
    route: "/api/store",
  });

  logger.logStart();
  logger.warn("store.method_not_allowed", {
    attemptedMethod: context.request.method,
  });
  logger.logEnd(405, {
    reason: "method_not_allowed",
  });

  return new Response("Method Not Allowed", { status: 405 });
};

/*
`/api/store` is the remote write boundary for drops. It accepts either plaintext payloads
or already-sealed envelopes, optionally adds a provider signature, and reserves the same
short-id alias namespace that `/d/:id` later resolves through.
*/

import type { R2Bucket } from "@cloudflare/workers-types";
import {
  DROP_ID_LENGTH,
  generateDropId,
  isDropIdToken,
  toShortDropId,
} from "../../../shared/drop/id";
import {
  isDropEnvelopeV1,
  isDropPayload,
  type DropEnvelopeV1,
} from "../../../shared/drop/types";
import { signProviderEnvelope, type ProviderSigningEnv } from "./dropEnvelopeSigning";
import { syncPublicDropIndexForEnvelope } from "./dropIndex";
import { removeRemoteAliasIfMatch, reserveRemoteAlias } from "./dropId";
import {
  R2DropObjectRepository,
  type PutDropObjectResult,
} from "./dropObjectRepository";
import { toLogRef, type RequestLogger } from "./logger";

/** Environment required by the store route service. */
export interface StoreServiceEnv extends ProviderSigningEnv {
  R2_BUCKET: R2Bucket;
  PUBLIC_BASE_URL: string;
}

/** Inputs passed from the `/api/store` HTTP adapter to the service. */
export interface StoreDropInput {
  request: Request;
  env: StoreServiceEnv;
  logger: RequestLogger;
}

interface StoreRequestBody {
  id?: string;
  upsert?: boolean;
  expectedRevision?: string;
  envelope?: unknown;
}

interface ApiErrorBody {
  error: string;
  code: string;
  details?: Record<string, unknown>;
}

const MAX_ID_ALLOCATION_ATTEMPTS = 64;

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

const sanitizeRevision = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) return null;

  const unwrapped = trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
  return unwrapped || null;
};

function validateEnv(env: StoreServiceEnv): void {
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
    return {
      id: null as string | null,
      upsert: false,
      expectedRevision: null as string | null,
      payload: parsed,
    };
  }

  const body = parsed as StoreRequestBody;
  if (body.envelope !== undefined) {
    return {
      id: sanitizeDropId(body.id),
      upsert: Boolean(body.upsert),
      expectedRevision: sanitizeRevision(body.expectedRevision),
      payload: body.envelope,
    };
  }

  return {
    id: sanitizeDropId(body.id),
    upsert: Boolean(body.upsert),
    expectedRevision: sanitizeRevision(body.expectedRevision),
    payload: parsed,
  };
};

const jsonErrorResponse = (
  status: number,
  code: string,
  error: string,
  details?: Record<string, unknown>,
): Response => {
  const payload: ApiErrorBody = {
    error,
    code,
    details,
  };

  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
};

/** Stores a plaintext payload or sealed envelope and returns the HTTP response body. */
export const storeDrop = async ({
  request,
  env,
  logger,
}: StoreDropInput): Promise<Response> => {
  try {
    validateEnv(env);

    const contentType = request.headers.get("Content-Type") || "";
    const isJson = contentType.includes("application/json");
    const rawBody = await request.text();
    let storedPayload = rawBody;
    let storedContentType = isJson ? "application/json" : "text/plain";
    let requestedId: string | null = null;
    let upsert = false;
    let expectedRevision: string | null = null;
    let payloadKind: "plain_text" | "drop_payload" | "drop_envelope" =
      "plain_text";
    let storedEnvelope: DropEnvelopeV1 | null = null;
    let allocationAttempts = 0;
    let aliasConflictCount = 0;
    let objectConflictCount = 0;
    const dropRepository = new R2DropObjectRepository(env.R2_BUCKET);

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
        return jsonErrorResponse(400, "invalid_json", "Invalid JSON payload.");
      }

      const parsedRequest = parseStoreRequest(parsed);
      requestedId = parsedRequest.id;
      upsert = parsedRequest.upsert;
      expectedRevision = parsedRequest.expectedRevision;

      if (isDropEnvelopeV1(parsedRequest.payload)) {
        payloadKind = "drop_envelope";
        // Provider signatures are attached server-side so the server only attests to what it actually stored.
        const signedEnvelope = await signProviderEnvelope(
          parsedRequest.payload,
          env,
          logger,
        );
        storedEnvelope = signedEnvelope;
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
          return jsonErrorResponse(
            400,
            "empty_payload_content",
            "Request body cannot be empty.",
          );
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
        return jsonErrorResponse(
          400,
          "unsupported_payload",
          "Unsupported JSON payload. Expected a drop payload or encrypted drop envelope.",
          {
            requestedDropRef: toLogRef(requestedId),
          },
        );
      }
    } else if (!rawBody.trim()) {
      logger.warn("store.empty_plain_text_body");
      logger.logEnd(400, {
        reason: "empty_plain_text_body",
      });
      return jsonErrorResponse(
        400,
        "empty_plain_text_body",
        "Request body cannot be empty.",
      );
    }

    let id: string | null = null;

    if (requestedId) {
      allocationAttempts = 1;
      const aliasState = await reserveRemoteAlias(
        env.R2_BUCKET,
        requestedId,
        logger,
      );
      if (aliasState === "conflict") {
        aliasConflictCount += 1;
        logger.warn("store.alias_conflict", {
          requestedDropRef: toLogRef(requestedId),
        });
        logger.logEnd(409, {
          reason: "alias_conflict",
          requestedDropRef: toLogRef(requestedId),
        });
        return jsonErrorResponse(
          409,
          "alias_conflict",
          "Drop short link is already in use.",
          {
            requestedDropRef: toLogRef(requestedId),
          },
        );
      }

      let storeResult: PutDropObjectResult = "conflict";

      try {
        storeResult = await dropRepository.put(requestedId, storedPayload, {
          contentType: storedContentType,
          upsert,
          expectedRevision,
        });
      } catch (error) {
        if (aliasState === "reserved") {
          await removeRemoteAliasIfMatch(env.R2_BUCKET, requestedId, logger);
        }

        throw error;
      }

      if (storeResult !== "stored") {
        if (storeResult === "precondition_failed") {
          logger.warn("store.revision_precondition_failed", {
            requestedDropRef: toLogRef(requestedId),
            upsert,
            hasExpectedRevision: Boolean(expectedRevision),
          });
          logger.logEnd(412, {
            reason: "revision_precondition_failed",
            requestedDropRef: toLogRef(requestedId),
            upsert,
            hasExpectedRevision: Boolean(expectedRevision),
          });
          return jsonErrorResponse(
            412,
            "revision_precondition_failed",
            "Drop revision precondition failed. Refresh and try again.",
            {
              requestedDropRef: toLogRef(requestedId),
              upsert,
            },
          );
        }

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
        return jsonErrorResponse(409, "object_conflict", "Drop ID already exists.", {
          requestedDropRef: toLogRef(requestedId),
          upsert,
        });
      }

      id = requestedId;
    } else {
      for (
        let attempt = 0;
        attempt < MAX_ID_ALLOCATION_ATTEMPTS;
        attempt += 1
      ) {
        allocationAttempts = attempt + 1;
        const candidateId = generateDropId(DROP_ID_LENGTH);
        const aliasState = await reserveRemoteAlias(
          env.R2_BUCKET,
          candidateId,
          logger,
        );
        if (aliasState === "conflict") {
          aliasConflictCount += 1;
          continue;
        }

        let storeResult: PutDropObjectResult = "conflict";

        try {
          storeResult = await dropRepository.put(candidateId, storedPayload, {
            contentType: storedContentType,
          });
        } catch (error) {
          if (aliasState === "reserved") {
            await removeRemoteAliasIfMatch(env.R2_BUCKET, candidateId, logger);
          }

          throw error;
        }

        if (storeResult === "stored") {
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
      return jsonErrorResponse(
        500,
        "id_allocation_failed",
        "Failed to allocate a unique drop ID.",
        {
          attempts: allocationAttempts,
          aliasConflictCount,
          objectConflictCount,
        },
      );
    }

    await syncPublicDropIndexForEnvelope(
      env.R2_BUCKET,
      id,
      storedEnvelope,
      Date.now(),
    );

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
    return jsonErrorResponse(
      500,
      "unhandled_error",
      `Failed to store drop: ${errorMessage}`,
    );
  }
};

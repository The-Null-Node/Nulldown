/*
`/api/store` is the remote write boundary for drops. It accepts either plaintext payloads
or already-sealed envelopes, optionally adds a provider signature, and reserves the same
short-id alias namespace that `/d/:id` later resolves through.
*/

import type { VoidBlobStore, VoidSqlStore } from "../../../../../src/server/ports";
import {
  DROP_ID_LENGTH,
  generateDropId,
  isDropIdToken,
  toShortDropId,
} from "../../../../../shared/drop/id";
import {
  isDropEnvelopeV1,
  isDropPayload,
  type DropEnvelopeV1,
} from "../../../../../shared/drop/types";
import { signProviderEnvelope, type ProviderSigningEnv } from "../../crypto/envelopes/signing";
import { syncPublicDropIndexForEnvelope } from "../index/repository";
import { removeRemoteAliasIfMatch, reserveRemoteAlias } from "../identity/id";
import {
  BlobDropObjectRepository,
  type PutDropObjectResult,
} from "../storage/objectRepository";
import { toLogRef, type RequestLogger } from "../../core/logging/logger";
import { createSearchDatabase } from "../../../../../src/lib/db/searchDatabase";

/** Environment required by the store route service. */
export interface StoreServiceEnv extends ProviderSigningEnv {
  blobs: VoidBlobStore;
  sql?: VoidSqlStore;
  PUBLIC_BASE_URL?: string;
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
  if (!env.blobs)
    throw new Error(
      "Blob store binding is required. Configure the platform storage adapter before calling storeDrop.",
    );
}

const resolvePublicBaseUrl = (env: StoreServiceEnv, request: Request): string =>
  (env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\/$/, "");

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

const upsertDropMetadata = async (input: {
  db?: VoidSqlStore;
  id: string;
  contentType: string;
  envelope: DropEnvelopeV1 | null;
  updatedAt: number;
}): Promise<void> => {
  if (!input.db) return;

  await input.db
    .prepare(
      `INSERT INTO drops (
         id, content_type, short_id, owner_account_id, visibility,
         created_at, updated_at, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         content_type = excluded.content_type,
         owner_account_id = excluded.owner_account_id,
         visibility = excluded.visibility,
         updated_at = excluded.updated_at,
         metadata_json = excluded.metadata_json`,
    )
    .bind(
      input.id,
      input.contentType,
      toShortDropId(input.id),
      input.envelope?.accountId ?? null,
      input.envelope?.visibility ?? "unlisted",
      input.updatedAt,
      input.updatedAt,
      input.envelope ? JSON.stringify(input.envelope.metadata) : null,
    )
    .run();
};

const extractTitleFromContent = (content: string): string | null => {
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ")) {
      return trimmed.slice(2).trim() || null;
    }
  }
  return null;
};

const indexDropForSearch = async (
  db: VoidSqlStore | undefined | null,
  id: string,
  content: string,
  envelope: DropEnvelopeV1 | null,
  updatedAt: number,
  logger: { warn: (msg: string, data?: Record<string, unknown>) => void },
): Promise<void> => {
  if (!db) return;

  try {
    const searchDb = createSearchDatabase(db);
    const title = extractTitleFromContent(content);
    const contentPreview = content.slice(0, 1000);
    const indexId = id;
    const visibility = envelope?.visibility ?? "unlisted";

    await searchDb.index({
      id: indexId,
      dropId: id,
      title,
      contentPreview,
      contentHash: null,
      ownerAccountId: envelope?.accountId ?? null,
      visibility,
      createdAt: updatedAt,
      updatedAt,
      metadata: envelope?.metadata ?? null,
    });
  } catch (error) {
    logger.warn("store.search_index_failed", {
      dropRef: id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
    let parsedDropPayload: unknown = null;
    const dropRepository = new BlobDropObjectRepository(env.blobs);

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
        parsedDropPayload = parsedRequest.payload;

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
        env.blobs,
        requestedId,
        logger,
        env.sql,
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
          await removeRemoteAliasIfMatch(env.blobs, requestedId, logger, env.sql);
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
          env.blobs,
          candidateId,
          logger,
          env.sql,
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
            await removeRemoteAliasIfMatch(env.blobs, candidateId, logger, env.sql);
          }

          throw error;
        }

        if (storeResult === "stored") {
          id = candidateId;
          break;
        }

        objectConflictCount += 1;
        if (aliasState === "reserved") {
          await removeRemoteAliasIfMatch(env.blobs, candidateId, logger, env.sql);
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

    const updatedAt = Date.now();
    await syncPublicDropIndexForEnvelope(
      env.blobs,
      id,
      storedEnvelope,
      updatedAt,
      env.sql,
    );
    await upsertDropMetadata({
      db: env.sql,
      id,
      contentType: storedContentType,
      envelope: storedEnvelope,
      updatedAt,
    });

    if (payloadKind !== "drop_envelope") {
      const indexContent = payloadKind === "plain_text"
        ? rawBody
        : (parsedDropPayload && typeof (parsedDropPayload as Record<string, unknown>).content === "string"
            ? String((parsedDropPayload as Record<string, unknown>).content)
            : storedPayload);
      await indexDropForSearch(
        env.sql,
        id,
        indexContent,
        storedEnvelope,
        updatedAt,
        logger,
      );
    }

    const baseUrl = resolvePublicBaseUrl(env, request);
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

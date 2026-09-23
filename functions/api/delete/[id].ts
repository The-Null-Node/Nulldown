import type { D1Database, PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import {
  createCloudflareBlobStore,
  createCloudflareSqlStore,
} from "../_lib/core/platform/cloudflare/storage";
import { removePublicDropIndexEntry } from "../_lib/drops/index/repository";
import { createDropIdentityRepository } from "../_lib/drops/identity/id";
import { acquireRootMutationLock } from "../_lib/drops/storage/mutation-lock";
import { createRequestLogger, toLogRef } from "../_lib/core/logging/logger";
import { readAccountLibraryEntry, tombstoneAccountLibraryEntry } from "../_lib/accounts/library/repository";
import { resolveAuthenticatedAccountId } from "../_lib/accounts/session/authentication";

interface Env {
  R2_BUCKET: R2Bucket;
  DB?: D1Database;
  ACCOUNT_AUTH_SECRET?: string;
  ALLOW_INSECURE_ACCOUNT_HEADER?: string;
}

const jsonErrorResponse = (
  status: number,
  code: string,
  error: string,
  details?: Record<string, unknown>,
): Response =>
  new Response(
    JSON.stringify({
      error,
      code,
      details,
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
      },
    },
  );

const resolveId = (id: string | string[] | undefined) =>
  typeof id === "string" ? id : Array.isArray(id) ? id[0] : "";

const normalizeRevision = (revision: string | null | undefined): string | null => {
  const value = revision?.trim();
  if (!value) return null;
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
};

export const onRequestDelete: PagesFunction<Env, "id"> = async ({
  env,
  params,
  request,
}) => {
  const logger = createRequestLogger({
    request,
    env,
    route: "/api/delete/:id",
  });

  const requestedId = resolveId(params.id);

  logger.logStart({
    requestedDropRef: toLogRef(requestedId),
  });

  try {
    if (!env.R2_BUCKET) {
      logger.error("delete.bucket_binding_missing", {
        requestedDropRef: toLogRef(requestedId),
      });
      logger.logEnd(500, {
        reason: "bucket_binding_missing",
        requestedDropRef: toLogRef(requestedId),
      });
      return jsonErrorResponse(
        500,
        "bucket_binding_missing",
        "R2 bucket binding is required.",
      );
    }

    const accountId = await resolveAuthenticatedAccountId(request, env);
    if (!accountId) {
      logger.logEnd(401, { reason: "account_auth_required" });
      return jsonErrorResponse(
        401,
        "account_auth_required",
        "An authenticated account session is required.",
      );
    }

    if (!env.DB) {
      logger.logEnd(503, { reason: "account_library_unavailable" });
      return jsonErrorResponse(
        503,
        "account_library_unavailable",
        "Account-library storage is required to delete a drop.",
      );
    }

    const blobs = createCloudflareBlobStore(env.R2_BUCKET);
    const sql = createCloudflareSqlStore(env.DB);
    if (!sql) {
      throw new Error("Account-library storage is required.");
    }

    const dropIdentityRepository = createDropIdentityRepository({
      blobs,
      sql,
    });
    const id = await dropIdentityRepository.resolveRemoteDropId(
      requestedId,
      logger,
    );

    if (!id) {
      logger.warn("delete.invalid_drop_id", {
        requestedDropRef: toLogRef(requestedId),
      });
      logger.logEnd(400, {
        reason: "invalid_drop_id",
        requestedDropRef: toLogRef(requestedId),
      });
      return jsonErrorResponse(400, "invalid_drop_id", "Drop ID is required.");
    }

    const rootMutationLock = await acquireRootMutationLock(blobs, id);
    try {
      const ownedEntry = await readAccountLibraryEntry(sql, id);
      if (
        !ownedEntry ||
        ownedEntry.account_id !== accountId ||
        ownedEntry.deleted_at !== null
      ) {
        logger.logEnd(404, {
          reason: "owned_drop_not_found",
          canonicalDropRef: toLogRef(id),
        });
        return jsonErrorResponse(404, "drop_not_found", "Drop not found.");
      }

      const expectedRevision = normalizeRevision(request.headers.get("If-Match"));
      if (!expectedRevision) {
        logger.logEnd(428, {
          reason: "revision_precondition_required",
          canonicalDropRef: toLogRef(id),
        });
        return jsonErrorResponse(
          428,
          "revision_precondition_required",
          "An If-Match drop revision is required to delete this drop.",
        );
      }

      const object = await env.R2_BUCKET.head(id);
      if (!object) {
        logger.logEnd(404, {
          reason: "drop_not_found",
          requestedDropRef: toLogRef(requestedId),
          canonicalDropRef: toLogRef(id),
        });
        return jsonErrorResponse(404, "drop_not_found", "Drop not found.", {
          requestedDropRef: toLogRef(requestedId),
          canonicalDropRef: toLogRef(id),
        });
      }

      if (normalizeRevision(object.etag ?? object.httpEtag) !== expectedRevision) {
        logger.warn("delete.revision_precondition_failed", {
          requestedDropRef: toLogRef(requestedId),
          canonicalDropRef: toLogRef(id),
        });
        logger.logEnd(412, {
          reason: "revision_precondition_failed",
          requestedDropRef: toLogRef(requestedId),
          canonicalDropRef: toLogRef(id),
        });
        return jsonErrorResponse(
          412,
          "revision_precondition_failed",
          "Drop revision precondition failed. Refresh and try again.",
          {
            requestedDropRef: toLogRef(requestedId),
            canonicalDropRef: toLogRef(id),
          },
        );
      }

      // Tombstone first so a later physical cleanup failure never leaves an active root.
      await rootMutationLock.beginCommit();
      await tombstoneAccountLibraryEntry(sql, id, Date.now());
      await rootMutationLock.beginCommit();
      await dropIdentityRepository.removeRemoteAliasIfMatch(id, logger);
      await rootMutationLock.beginCommit();
      await removePublicDropIndexEntry(blobs, id, sql);
      await rootMutationLock.beginCommit();
      await sql.prepare("DELETE FROM drops WHERE id = ?").bind(id).run();
      await rootMutationLock.beginCommit();
      await env.R2_BUCKET.delete(id);
    } finally {
      await rootMutationLock.release();
    }

    logger.logEnd(204, {
      requestedDropRef: toLogRef(requestedId),
      canonicalDropRef: toLogRef(id),
    });

    return new Response(null, { status: 204 });
  } catch (error: unknown) {
    logger.logError("delete.unhandled_error", error, {
      requestedDropRef: toLogRef(requestedId),
    });
    logger.logEnd(500, {
      reason: "unhandled_error",
      requestedDropRef: toLogRef(requestedId),
    });
    return jsonErrorResponse(
      500,
      "unhandled_error",
      "Failed to delete drop.",
    );
  }
};

export const onRequest: PagesFunction<Env, "id"> = async (context) => {
  if (context.request.method === "DELETE") {
    return onRequestDelete(context);
  }

  const logger = createRequestLogger({
    request: context.request,
    env: context.env,
    route: "/api/delete/:id",
  });

  logger.logStart();
  logger.warn("delete.method_not_allowed", {
    attemptedMethod: context.request.method,
  });
  logger.logEnd(405, {
    reason: "method_not_allowed",
  });

  return new Response("Method Not Allowed", { status: 405 });
};

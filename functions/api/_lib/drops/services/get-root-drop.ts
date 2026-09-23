import type {
  BlobObject,
  BlobObjectStore,
  SqlMetadataStore,
} from "../../../../../src/server/ports";
import { createDropIdentityRepository } from "../identity/id";
import { toLogRef, type RequestLogger } from "../../core/logging/logger";
import {
  canReadRoot,
  resolveRootReadAuthorization,
} from "../../security/read-authorization";
import type { AccountAuthEnv } from "../../accounts/session/authentication";

/** Environment required by the shared root-object read service. */
export interface GetRootDropServiceEnv extends AccountAuthEnv {
  blobs: BlobObjectStore;
  sql?: SqlMetadataStore;
}

/** Inputs supplied by platform HTTP adapters to the root-object read service. */
export interface GetRootDropInput {
  request: Request;
  requestedId: string;
  env: GetRootDropServiceEnv;
  logger: RequestLogger;
}

const copyHttpMetadata = (headers: Headers, object: BlobObject): void => {
  const headerNames: Record<string, string> = {
    contentType: "Content-Type",
    contentLanguage: "Content-Language",
    contentDisposition: "Content-Disposition",
    contentEncoding: "Content-Encoding",
    cacheControl: "Cache-Control",
    cacheExpiry: "Expires",
  };
  Object.entries(object.httpMetadata ?? {}).forEach(([key, value]) => {
    if (typeof value === "string") headers.set(headerNames[key] ?? key, value);
    if (value && typeof value === "object" && value instanceof Date) {
      headers.set(headerNames[key] ?? key, value.toUTCString());
    }
  });
};

/** Resolves, authorizes, and streams one root drop object without parsing its body. */
export const getRootDrop = async ({
  request,
  requestedId,
  env,
  logger,
}: GetRootDropInput): Promise<Response> => {
  try {
    if (!env.blobs) {
      throw new Error("Blob store binding is required.");
    }

    const identity = createDropIdentityRepository({
      blobs: env.blobs,
      sql: env.sql,
    });
    const id = await identity.resolveRemoteDropIdForReadRequest(
      requestedId,
      logger,
    );
    if (!id) {
      logger.warn("get.invalid_drop_id", {
        requestedDropRef: toLogRef(requestedId),
      });
      logger.logEnd(400, { reason: "invalid_drop_id" });
      return new Response("Drop ID is required.", { status: 400 });
    }

    const canonicalDropRef = toLogRef(id);
    const authorization = await resolveRootReadAuthorization(
      request,
      { ...env, DB: env.sql },
      id,
    );
    if (!canReadRoot(authorization)) {
      logger.logEnd(404, { reason: "drop_not_found", canonicalDropRef });
      return new Response("Drop not found.", { status: 404 });
    }

    const object = await env.blobs.get(id);
    if (!object) {
      logger.warn("get.drop_not_found", {
        requestedDropRef: toLogRef(requestedId),
        canonicalDropRef,
      });
      logger.logEnd(404, { reason: "drop_not_found", canonicalDropRef });
      return new Response("Drop not found.", { status: 404 });
    }

    const contentType = object.httpMetadata?.contentType || "text/plain";
    const headers = new Headers({
      "Content-Type": contentType,
      "X-Drop-Canonical-Id": id,
    });
    if (object.httpEtag) {
      headers.set("ETag", object.httpEtag);
      headers.set("X-Drop-Revision", object.httpEtag);
    }
    copyHttpMetadata(headers, object);

    logger.logEnd(200, { canonicalDropRef, contentType });
    return new Response(object.body ?? (await object.text()), {
      status: 200,
      headers,
    });
  } catch (error: unknown) {
    logger.logError("get.unhandled_error", error, {
      requestedDropRef: toLogRef(requestedId),
    });
    logger.logEnd(500, { reason: "unhandled_error" });
    return new Response("Failed to retrieve drop.", { status: 500 });
  }
};

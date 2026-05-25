/*
 `/api/nullplug/registry` stores signed remote nullplug manifests. Registration is
 authenticated and allowlist-gated; this endpoint does not execute remote plugins.
*/

import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import {
  isRemoteNullplugManifest,
  isRemoteNullplugManifestAllowed,
  isRemoteNullplugRegistryRecord,
  NULLPLUG_MANIFEST_SIGNATURE_PREFIX,
  NULLPLUG_REGISTRY_LATEST_KEY_PREFIX,
  serializeRemoteNullplugManifestForSignature,
  writeRemoteNullplugManifest,
  type RemoteNullplugManifest,
  type RemoteNullplugRegistryRecord,
} from "../../../shared/nullplug/registry";
import { normalizeAllowedHosts } from "../../../shared/nullplug/policy";
import {
  resolveAuthenticatedAccountId,
  type AccountAuthEnv,
} from "../_lib/accountAuth";
import { timingSafeStringEqual } from "../_lib/auth";
import { createRequestLogger } from "../_lib/logger";
import {
  jsonErrorResponse,
  jsonResponse,
  methodNotAllowedResponse,
  readRequestTextWithLimit,
} from "../_lib/http";

interface Env extends AccountAuthEnv {
  R2_BUCKET: R2Bucket;
  NULLPLUG_REGISTRY_ALLOWED_HOSTS?: string;
  NULLPLUG_REGISTRY_SIGNATURE_SECRET?: string;
}

const REGISTRY_BODY_MAX_BYTES = 512_000;
const REGISTRY_LIST_LIMIT = 200;
const textEncoder = new TextEncoder();

const parseAllowedHosts = (value: string | undefined): string[] =>
  normalizeAllowedHosts(
    (value ?? "")
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  );

const parseManifestBody = (rawBody: string): RemoteNullplugManifest | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }

  if (isRemoteNullplugManifest(parsed)) return parsed;
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "manifest" in parsed &&
    isRemoteNullplugManifest((parsed as { manifest?: unknown }).manifest)
  ) {
    return (parsed as { manifest: RemoteNullplugManifest }).manifest;
  }
  return null;
};

const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const signManifestPayload = async (
  secret: string,
  payload: string,
): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(payload));
  return `${NULLPLUG_MANIFEST_SIGNATURE_PREFIX}${toHex(new Uint8Array(signature))}`;
};

const verifyManifestSignature = async (
  secret: string,
  manifest: RemoteNullplugManifest,
): Promise<boolean> => {
  if (!manifest.signature?.startsWith(NULLPLUG_MANIFEST_SIGNATURE_PREFIX)) {
    return false;
  }
  const expected = await signManifestPayload(
    secret,
    serializeRemoteNullplugManifestForSignature(manifest),
  );
  return timingSafeStringEqual(manifest.signature, expected);
};

const readRegistryRecord = async (
  object: { json: () => Promise<unknown> } | null,
): Promise<RemoteNullplugRegistryRecord | null> => {
  if (!object) return null;
  try {
    const parsed = await object.json();
    return isRemoteNullplugRegistryRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const handleGet = async (env: Env, request: Request): Promise<Response> => {
  const logger = createRequestLogger({
    request,
    env,
    route: "/api/nullplug/registry",
  });
  logger.logStart();

  try {
    if (!env.R2_BUCKET) {
      logger.logEnd(500, { reason: "bucket_missing" });
      return new Response("R2 bucket binding is required.", { status: 500 });
    }

    const listed = await env.R2_BUCKET.list({
      prefix: NULLPLUG_REGISTRY_LATEST_KEY_PREFIX,
      limit: REGISTRY_LIST_LIMIT,
    });
    const records = await Promise.all(
      listed.objects.map((entry) => env.R2_BUCKET.get(entry.key).then(readRegistryRecord)),
    );
    const items = records
      .filter((entry): entry is RemoteNullplugRegistryRecord =>
        Boolean(entry && entry.status === "active"),
      )
      .map((entry) => entry.manifest)
      .sort((left, right) => left.id.localeCompare(right.id));

    logger.logEnd(200, { returned: items.length, truncated: listed.truncated });
    return jsonResponse({ items, cursor: listed.truncated ? listed.cursor : null });
  } catch (error) {
    logger.logError("nullplug.registry.get.unhandled_error", error);
    logger.logEnd(500, { reason: "unhandled_error" });
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Failed to list nullplug registry: ${message}`, {
      status: 500,
    });
  }
};

const handlePost = async (env: Env, request: Request): Promise<Response> => {
  const logger = createRequestLogger({
    request,
    env,
    route: "/api/nullplug/registry",
  });
  logger.logStart();

  try {
    if (!env.R2_BUCKET) {
      logger.logEnd(500, { reason: "bucket_missing" });
      return new Response("R2 bucket binding is required.", { status: 500 });
    }

    const accountId = await resolveAuthenticatedAccountId(request, env);
    if (!accountId) {
      logger.logEnd(401, { reason: "unauthorized" });
      return jsonErrorResponse(401, "unauthorized", "Authentication required.");
    }

    if (!env.NULLPLUG_REGISTRY_SIGNATURE_SECRET) {
      logger.logEnd(503, { reason: "signature_secret_missing" });
      return jsonErrorResponse(
        503,
        "signature_secret_missing",
        "NULLPLUG_REGISTRY_SIGNATURE_SECRET is required.",
      );
    }

    const allowedHosts = parseAllowedHosts(env.NULLPLUG_REGISTRY_ALLOWED_HOSTS);
    const rawBody = await readRequestTextWithLimit(request, REGISTRY_BODY_MAX_BYTES);
    const manifest = parseManifestBody(rawBody);
    if (!manifest) {
      logger.logEnd(400, { reason: "invalid_manifest" });
      return jsonErrorResponse(
        400,
        "validation_failed",
        "Invalid remote nullplug manifest.",
      );
    }

    if (!(await verifyManifestSignature(env.NULLPLUG_REGISTRY_SIGNATURE_SECRET, manifest))) {
      logger.logEnd(401, { reason: "invalid_signature", pluginId: manifest.id });
      return jsonErrorResponse(
        401,
        "invalid_signature",
        "Remote nullplug manifest signature verification failed.",
      );
    }

    if (!isRemoteNullplugManifestAllowed(manifest, allowedHosts)) {
      logger.logEnd(400, { reason: "manifest_not_allowed", pluginId: manifest.id });
      return jsonErrorResponse(
        400,
        "manifest_not_allowed",
        "Remote nullplug manifest is not allowed by registry host policy.",
      );
    }

    const now = Date.now();
    const record: RemoteNullplugRegistryRecord = {
      version: 1,
      manifest,
      status: "active",
      createdAt: now,
      updatedAt: now,
      registeredBy: accountId,
    };
    await writeRemoteNullplugManifest(env.R2_BUCKET, record, allowedHosts);

    logger.logEnd(200, { pluginId: manifest.id, accountId });
    return jsonResponse({ registered: true, record });
  } catch (error) {
    logger.logError("nullplug.registry.post.unhandled_error", error);
    logger.logEnd(500, { reason: "unhandled_error" });
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Failed to register nullplug manifest: ${message}`, {
      status: 500,
    });
  }
};

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method === "GET") {
    return handleGet(context.env, context.request);
  }

  if (context.request.method === "POST") {
    return handlePost(context.env, context.request);
  }

  return methodNotAllowedResponse();
};

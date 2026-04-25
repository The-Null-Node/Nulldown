import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import {
  isDropDiffEnvelope,
  type DropDiffEvent,
  type DropDiffPollResponse,
} from "../../../shared/drop/diff";
import {
  buildDiffSigningPayload,
  DIFF_AUTH_DEFAULT_MAX_SKEW_MS,
  DIFF_CLIENT_ID_HEADER,
  DIFF_SECRET_KID_HEADER,
  DIFF_SIGNATURE_HEADER,
  DIFF_SIGNATURE_PREFIX,
  DIFF_TIMESTAMP_HEADER,
  isTimestampFresh,
} from "../../../shared/drop/diffAuth";
import {
  readDiffAuthCredential,
  sanitizeDiffAuthToken,
} from "../_lib/diffAuth";
import { readRequestAccountId } from "../_lib/accountAuth";
import { type DropBranchRecord } from "../../../shared/drop/branch";
import {
  appendEventsToBranch,
  readBranch,
  readBranchDiffLog,
  resolveBranchForActor,
} from "../_lib/branchState";
import { resolveRemoteDropId } from "../_lib/dropId";
import { createRequestLogger, toLogRef } from "../_lib/logger";

interface Env {
  R2_BUCKET: R2Bucket;
  DIFF_WEBHOOK_SECRET?: string;
  DIFF_AUTH_MAX_SKEW_MS?: string;
  PROVIDER_ENCRYPTION_PRIVATE_JWK?: string;
}

const textEncoder = new TextEncoder();

const MAX_EVENTS_PER_REQUEST = 100;
const MAX_POLL_LIMIT = 200;
const DEFAULT_POLL_LIMIT = 50;

const resolveId = (id: string | string[] | undefined) =>
  typeof id === "string" ? id : Array.isArray(id) ? id[0] : "";

const resolveMaxSkewMs = (raw: string | undefined): number => {
  if (!raw) {
    return DIFF_AUTH_DEFAULT_MAX_SKEW_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DIFF_AUTH_DEFAULT_MAX_SKEW_MS;
  }

  return parsed;
};

const importHmacKey = async (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

const hexToBytes = (hex: string): Uint8Array | null => {
  if (hex.length % 2 !== 0) {
    return null;
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    const byte = Number.parseInt(hex.slice(index, index + 2), 16);
    if (Number.isNaN(byte)) {
      return null;
    }

    bytes[index / 2] = byte;
  }

  return bytes;
};

const verifyHmacSignature = async (
  secret: string,
  payload: string,
  signatureHeader: string,
): Promise<boolean> => {
  const signatureHex = signatureHeader
    .trim()
    .replace(new RegExp(`^${DIFF_SIGNATURE_PREFIX}`), "");
  const expectedBytes = hexToBytes(signatureHex);
  if (!expectedBytes) {
    return false;
  }

  const key = await importHmacKey(secret);

  return crypto.subtle.verify(
    "HMAC",
    key,
    expectedBytes,
    textEncoder.encode(payload),
  );
};

const resolveRequestedBranchId = (request: Request): string | null => {
  const url = new URL(request.url);
  const branchId = url.searchParams.get("branchId");
  return sanitizeDiffAuthToken(branchId);
};

const verifyDiffRequestAuth = async (
  env: Env,
  request: Request,
  dropId: string,
  rawBody: string,
): Promise<
  | {
      ok: true;
      mode: "provider" | "env" | "none";
      branchId: string | null;
      clientId: string | null;
    }
  | { ok: false; status: number; message: string; reason: string }
> => {
  const signature = request.headers.get(DIFF_SIGNATURE_HEADER)?.trim() || "";
  const clientId = sanitizeDiffAuthToken(request.headers.get(DIFF_CLIENT_ID_HEADER));
  const kid = sanitizeDiffAuthToken(request.headers.get(DIFF_SECRET_KID_HEADER));
  const timestamp = request.headers.get(DIFF_TIMESTAMP_HEADER)?.trim() || "";

  if (clientId || kid) {
    if (!signature || !clientId || !kid || !timestamp) {
      return {
        ok: false,
        status: 401,
        reason: "provider_auth_missing_headers",
        message:
          "Provider auth requires client id, secret kid, timestamp, and signature headers.",
      };
    }

    const maxSkewMs = resolveMaxSkewMs(env.DIFF_AUTH_MAX_SKEW_MS);
    if (!isTimestampFresh(timestamp, Date.now(), maxSkewMs)) {
      return {
        ok: false,
        status: 401,
        reason: "provider_auth_stale_timestamp",
        message: "Provider auth timestamp is stale.",
      };
    }

    const credential = await readDiffAuthCredential(env.R2_BUCKET, dropId, clientId, kid);
    if (!credential) {
      return {
        ok: false,
        status: 403,
        reason: "provider_auth_credential_missing",
        message: "Unknown provider auth credential.",
      };
    }

    if (credential.expiresAt !== null && credential.expiresAt < Date.now()) {
      return {
        ok: false,
        status: 403,
        reason: "provider_auth_credential_expired",
        message: "Provider auth credential expired.",
      };
    }

    const path = new URL(request.url).pathname;
    const payload = buildDiffSigningPayload(request.method, path, timestamp, rawBody);
    const valid = await verifyHmacSignature(credential.secret, payload, signature);
    if (!valid) {
      return {
        ok: false,
        status: 403,
        reason: "provider_auth_invalid_signature",
        message: "Invalid provider auth signature.",
      };
    }

    return {
      ok: true,
      mode: "provider",
      branchId: credential.branchId,
      clientId,
    };
  }

  if (env.DIFF_WEBHOOK_SECRET) {
    if (!signature) {
      return {
        ok: false,
        status: 401,
        reason: "env_auth_missing_signature",
        message: "Missing webhook signature.",
      };
    }

    const path = new URL(request.url).pathname;
    const validCanonical = timestamp
      ? await verifyHmacSignature(
          env.DIFF_WEBHOOK_SECRET,
          buildDiffSigningPayload(request.method, path, timestamp, rawBody),
          signature,
        )
      : false;

    const validLegacy = await verifyHmacSignature(
      env.DIFF_WEBHOOK_SECRET,
      rawBody,
      signature,
    );

    if (!validCanonical && !validLegacy) {
      return {
        ok: false,
        status: 403,
        reason: "env_auth_invalid_signature",
        message: "Invalid webhook signature.",
      };
    }

    return {
      ok: true,
      mode: "env",
      branchId: null,
      clientId: null,
    };
  }

  return {
    ok: true,
    mode: "none",
    branchId: null,
    clientId,
  };
};

const resolveBranchForRequest = async (
  env: Env,
  dropId: string,
  request: Request,
  auth: { mode: "provider" | "env" | "none"; branchId: string | null; clientId: string | null },
): Promise<DropBranchRecord> => {
  if (auth.branchId) {
    const branch = await readBranch(env.R2_BUCKET, dropId, auth.branchId);
    if (!branch) {
      throw new Error("Resolved branch credential points to a missing branch.");
    }
    return branch;
  }

  const accountId = readRequestAccountId(request);
  const requestedBranchId = resolveRequestedBranchId(request);
  if (requestedBranchId) {
    const branch = await readBranch(env.R2_BUCKET, dropId, requestedBranchId);
    if (branch) {
      return branch;
    }
  }

  const resolved = await resolveBranchForActor(
    env.R2_BUCKET,
    dropId,
    accountId,
    auth.clientId,
    env.PROVIDER_ENCRYPTION_PRIVATE_JWK,
  );
  return resolved.branch;
};

const handlePost = async (
  env: Env,
  params: { id: string | string[] },
  request: Request,
): Promise<Response> => {
  const logger = createRequestLogger({
    request,
    env,
    route: "/api/diff/:id",
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

    const id = await resolveRemoteDropId(env.R2_BUCKET, requestedId, logger);
    if (!id) {
      logger.logEnd(400, { reason: "invalid_drop_id" });
      return new Response("Drop ID is required.", { status: 400 });
    }

    const rawBody = await request.text();

    const auth = await verifyDiffRequestAuth(env, request, id, rawBody);
    if ("status" in auth) {
      logger.logEnd(auth.status, {
        reason: auth.reason,
        requestedDropRef: toLogRef(requestedId),
        dropRef: toLogRef(id),
      });
      return new Response(auth.message, { status: auth.status });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      logger.logEnd(400, { reason: "invalid_json", dropRef: toLogRef(id) });
      return new Response("Invalid JSON.", { status: 400 });
    }

    if (!isDropDiffEnvelope(parsed)) {
      logger.logEnd(400, { reason: "invalid_envelope", dropRef: toLogRef(id) });
      return new Response("Invalid diff envelope.", { status: 400 });
    }

    if (parsed.events.length > MAX_EVENTS_PER_REQUEST) {
      logger.logEnd(400, { reason: "too_many_events", dropRef: toLogRef(id) });
      return new Response(
        `Too many events. Max ${MAX_EVENTS_PER_REQUEST} per request.`,
        { status: 400 },
      );
    }

    const branch = await resolveBranchForRequest(env, id, request, auth);

    const mismatch = parsed.events.find((event) => event.dropId !== id);
    if (mismatch) {
      logger.logEnd(400, { reason: "drop_id_mismatch", dropRef: toLogRef(id) });
      return new Response("Event dropId does not match route.", { status: 400 });
    }

    const existing = await readBranchDiffLog(env.R2_BUCKET, id, branch.branchId);
    const existingIds = new Set(existing.map((event) => event.eventId));
    const newEvents = parsed.events.filter((event) => !existingIds.has(event.eventId));

    if (newEvents.length > 0) {
      const nextSeqBase =
        existing.length > 0 ? Math.max(...existing.map((event) => event.seq)) + 1 : 0;
      const sequenced = newEvents.map((event, index) => ({
        ...event,
        seq: nextSeqBase + index,
        snapshotId: branch.headSnapshotId + 1,
      }));
      const appended = await appendEventsToBranch(env.R2_BUCKET, branch, sequenced);
      const merged = [...existing, ...sequenced];

      logger.logEnd(200, {
        dropRef: toLogRef(id),
        branchRef: toLogRef(branch.branchId),
        authMode: auth.mode,
        accepted: sequenced.length,
        deduplicated: parsed.events.length - newEvents.length,
        totalStored: merged.length,
        snapshotId: appended.snapshot.snapshotId,
      });

      return new Response(
        JSON.stringify({
          accepted: sequenced.length,
          branchId: branch.branchId,
          snapshotId: appended.snapshot.snapshotId,
          totalStored: merged.length,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    logger.logEnd(200, {
      dropRef: toLogRef(id),
      branchRef: toLogRef(branch.branchId),
      authMode: auth.mode,
      accepted: 0,
      deduplicated: parsed.events.length,
      totalStored: existing.length,
    });

    return new Response(
      JSON.stringify({
        accepted: 0,
        branchId: branch.branchId,
        snapshotId: branch.headSnapshotId,
        totalStored: existing.length,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error: unknown) {
    logger.logError("diff.post.unhandled_error", error, {
      requestedDropRef: toLogRef(requestedId),
    });
    logger.logEnd(500, { reason: "unhandled_error" });
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Failed to store diffs: ${message}`, { status: 500 });
  }
};

const handleGet = async (
  env: Env,
  params: { id: string | string[] },
  request: Request,
): Promise<Response> => {
  const logger = createRequestLogger({
    request,
    env,
    route: "/api/diff/:id",
    successSampleRate: 0.1,
  });

  const requestedId = resolveId(params.id);
  logger.logStart({ requestedDropRef: toLogRef(requestedId) });

  try {
    if (!env.R2_BUCKET) {
      logger.logEnd(500, { reason: "bucket_missing" });
      return new Response("R2 bucket binding is required.", { status: 500 });
    }

    const id = await resolveRemoteDropId(env.R2_BUCKET, requestedId, logger);
    if (!id) {
      logger.logEnd(400, { reason: "invalid_drop_id" });
      return new Response("Drop ID is required.", { status: 400 });
    }

    const url = new URL(request.url);
    const cursorParam = url.searchParams.get("cursor");

    if (cursorParam === "__latest__") {
      const branch = await resolveBranchForRequest(env, id, request, {
        mode: "none",
        branchId: resolveRequestedBranchId(request),
        clientId: sanitizeDiffAuthToken(url.searchParams.get("excludeClient")),
      });
      const all = await readBranchDiffLog(env.R2_BUCKET, id, branch.branchId);
      const maxSeq = all.length > 0 ? Math.max(...all.map((event) => event.seq)) : -1;
      const response: DropDiffPollResponse = {
        events: [],
        cursor: maxSeq >= 0 ? String(maxSeq) : null,
      };
        logger.logEnd(200, {
          dropRef: toLogRef(id),
          branchRef: toLogRef(branch.branchId),
          returned: 0,
          totalStored: all.length,
        });
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    const afterSeq = cursorParam !== null ? Number.parseInt(cursorParam, 10) : -1;
    const excludeClient = url.searchParams.get("excludeClient") || undefined;
    const limitParam = Number.parseInt(url.searchParams.get("limit") || "", 10);
    const limit = Number.isFinite(limitParam)
      ? Math.max(1, Math.min(MAX_POLL_LIMIT, limitParam))
      : DEFAULT_POLL_LIMIT;

    const branch = await resolveBranchForRequest(env, id, request, {
      mode: "none",
      branchId: resolveRequestedBranchId(request),
      clientId: sanitizeDiffAuthToken(excludeClient),
    });

    const all = await readBranchDiffLog(env.R2_BUCKET, id, branch.branchId);

    let filtered = all.filter((event) => event.seq > afterSeq);
    if (excludeClient) {
      filtered = filtered.filter((event) => event.sourceClientId !== excludeClient);
    }

    const page = filtered.slice(0, limit);
    const nextCursor = page.length > 0 ? String(page[page.length - 1].seq) : null;

    const response: DropDiffPollResponse = {
      events: page,
      cursor: nextCursor,
    };

    logger.logEnd(200, {
      dropRef: toLogRef(id),
      branchRef: toLogRef(branch.branchId),
      returned: page.length,
      totalStored: all.length,
    });

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error: unknown) {
    logger.logError("diff.get.unhandled_error", error, {
      requestedDropRef: toLogRef(requestedId),
    });
    logger.logEnd(500, { reason: "unhandled_error" });
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Failed to read diffs: ${message}`, { status: 500 });
  }
};

export const onRequest: PagesFunction<Env, "id"> = async (context) => {
  if (context.request.method === "POST") {
    return handlePost(context.env, context.params, context.request);
  }

  if (context.request.method === "GET") {
    return handleGet(context.env, context.params, context.request);
  }

  const logger = createRequestLogger({
    request: context.request,
    env: context.env,
    route: "/api/diff/:id",
  });

  logger.logStart();
  logger.logEnd(405, {
    reason: "method_not_allowed",
    attemptedMethod: context.request.method,
  });

  return new Response("Method Not Allowed", { status: 405 });
};

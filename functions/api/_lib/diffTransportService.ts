/*
`/api/diff/:id` is the live branch editing transport. It accepts append-only diff events,
resolves the caller to the correct branch, and supports three auth modes: provider-issued
branch credentials, an environment webhook secret, or unauthenticated local development.
*/

import type { R2Bucket } from "@cloudflare/workers-types";
import { z } from "zod";
import {
  type DropDiffEvent,
  type DropDiffPollResponse,
} from "../../../shared/drop/diff";
import {
  DIFF_TOKEN_MAX_LENGTH,
  DropDiffEnvelopeSchema,
} from "../../../shared/drop/diffSchemas";
import { sanitizeDiffAuthToken } from "./diffAuth";
import {
  verifyDiffRequestAuth,
  type DiffRequestAuthSuccess,
} from "./diffRequestAuth";
import {
  resolveAuthenticatedAccountId,
  type AccountAuthEnv,
} from "./accountAuth";
import { type DropBranchRecord } from "../../../shared/drop/branch";
import {
  appendEventsToBranch,
} from "./branchAppendService";
import {
  pollBranchDiffEventsSince,
  readBranchHeadEventSeq,
} from "./branchDiffLogRepository";
import { resolveBranchForActor } from "./branchLifecycleService";
import { readBranch } from "./branchRepository";
import { resolveRemoteDropId } from "./dropId";
import { createRequestLogger, toLogRef } from "./logger";
import {
  apiHttpErrorResponse,
  isApiHttpError,
  jsonResponse,
  parseJsonTextWithSchema,
  parseWithSchema,
  readRequestTextWithLimit,
  type JsonValue,
} from "./http";

/** Environment required by the diff transport service. */
export interface DiffTransportEnv extends AccountAuthEnv {
  R2_BUCKET: R2Bucket;
  DIFF_WEBHOOK_SECRET?: string;
  DIFF_AUTH_MAX_SKEW_MS?: string;
  PROVIDER_ENCRYPTION_PRIVATE_JWK?: string;
}

/** Route parameters passed from the `/api/diff/:id` adapter. */
export interface DiffTransportParams {
  id: string | string[];
}

const MAX_POLL_LIMIT = 200;
const DEFAULT_POLL_LIMIT = 50;
const DIFF_REQUEST_BODY_MAX_BYTES = 2_000_000;

const diffPollQuerySchema = z
  .object({
    cursor: z
      .union([z.literal("__latest__"), z.string().regex(/^-?\d+$/)])
      .nullable(),
    excludeClient: z
      .string()
      .trim()
      .min(1)
      .max(DIFF_TOKEN_MAX_LENGTH)
      .optional(),
    limit: z
      .string()
      .regex(/^\d+$/)
      .transform((value) => Number.parseInt(value, 10))
      .pipe(z.number().int().min(1).max(MAX_POLL_LIMIT))
      .optional(),
  })
  .strict();

type DiffPollQuery = z.infer<typeof diffPollQuerySchema>;

const resolveId = (id: string | string[] | undefined) =>
  typeof id === "string" ? id : Array.isArray(id) ? id[0] : "";

const resolveRequestedBranchId = (request: Request): string | null => {
  const url = new URL(request.url);
  const branchId = url.searchParams.get("branchId");
  return sanitizeDiffAuthToken(branchId);
};

const parseDiffPollQuery = (request: Request): DiffPollQuery => {
  const url = new URL(request.url);
  const query: { [key: string]: JsonValue } = {
    cursor: url.searchParams.get("cursor"),
  };
  const excludeClient = url.searchParams.get("excludeClient");
  const limit = url.searchParams.get("limit");

  if (excludeClient !== null) {
    query.excludeClient = excludeClient;
  }
  if (limit !== null) {
    query.limit = limit;
  }

  return parseWithSchema(
    diffPollQuerySchema,
    query,
    "Invalid diff poll query.",
  );
};

const resolveBranchForDiffRequest = async (
  env: DiffTransportEnv,
  dropId: string,
  request: Request,
  auth: Pick<DiffRequestAuthSuccess, "mode" | "branchId" | "clientId">,
): Promise<DropBranchRecord> => {
  if (auth.branchId) {
    const branch = await readBranch(env.R2_BUCKET, dropId, auth.branchId);
    if (!branch) {
      throw new Error("Resolved branch credential points to a missing branch.");
    }
    return branch;
  }

  const accountId = await resolveAuthenticatedAccountId(request, env);
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

/** Appends posted diff events to the resolved branch. */
export const postDiffEvents = async (
  env: DiffTransportEnv,
  params: DiffTransportParams,
  request: Request,
  waitUntil?: (promise: Promise<void>) => void,
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

    const rawBody = await readRequestTextWithLimit(
      request,
      DIFF_REQUEST_BODY_MAX_BYTES,
    );

    const auth = await verifyDiffRequestAuth(env, request, id, rawBody);
    if (!auth.ok) {
      logger.logEnd(auth.status, {
        reason: auth.reason,
        requestedDropRef: toLogRef(requestedId),
        dropRef: toLogRef(id),
      });
      return new Response(auth.message, { status: auth.status });
    }

    const parsed = parseJsonTextWithSchema(
      rawBody,
      DropDiffEnvelopeSchema,
      "Invalid diff envelope.",
    );

    const branch = await resolveBranchForDiffRequest(env, id, request, auth);

    const mismatch = parsed.events.find((event) => event.dropId !== id);
    if (mismatch) {
      logger.logEnd(400, { reason: "drop_id_mismatch", dropRef: toLogRef(id) });
      return new Response("Event dropId does not match route.", {
        status: 400,
      });
    }

    const appended = await appendEventsToBranch(
      env.R2_BUCKET,
      branch,
      parsed.events,
      {
        waitUntil,
        onObserverError: (error, observerId) => {
          logger.logError("diff.branch_observer_failed", error, {
            observerId,
            dropRef: toLogRef(id),
            branchRef: toLogRef(branch.branchId),
          });
        },
      },
    );
    const snapshotId =
      appended.snapshot?.snapshotId ?? appended.branch.headSnapshotId;

    logger.logEnd(200, {
      dropRef: toLogRef(id),
      branchRef: toLogRef(branch.branchId),
      authMode: auth.mode,
      accepted: appended.acceptedEvents.length,
      deduplicated: appended.deduplicatedCount,
      totalStored: appended.totalStored,
      snapshotId,
    });

    return jsonResponse({
      accepted: appended.acceptedEvents.length,
      branchId: branch.branchId,
      snapshotId,
      totalStored: appended.totalStored,
    });
  } catch (error: unknown) {
    if (isApiHttpError(error)) {
      logger.logEnd(error.status, {
        reason: error.code,
        requestedDropRef: toLogRef(requestedId),
      });
      return apiHttpErrorResponse(error);
    }

    const message = error instanceof Error ? error.message : String(error);

    if (message === "branch_lock_timeout") {
      logger.logEnd(409, { reason: "branch_busy" });
      return new Response("Branch is busy. Retry shortly.", { status: 409 });
    }

    logger.logError("diff.post.unhandled_error", error, {
      requestedDropRef: toLogRef(requestedId),
    });
    logger.logEnd(500, { reason: "unhandled_error" });
    return new Response(`Failed to store diffs: ${message}`, { status: 500 });
  }
};

/** Polls diff events for the resolved branch. */
export const pollDiffEvents = async (
  env: DiffTransportEnv,
  params: DiffTransportParams,
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

    const query = parseDiffPollQuery(request);
    const cursorParam = query.cursor;

    if (cursorParam === "__latest__") {
      // The editor handshake asks for the current cursor only so it can start tailing fresh events.
      const branch = await resolveBranchForDiffRequest(env, id, request, {
        mode: "none",
        branchId: resolveRequestedBranchId(request),
        clientId: sanitizeDiffAuthToken(query.excludeClient ?? null),
      });
      const maxSeq =
        typeof branch.headEventSeq === "number"
          ? branch.headEventSeq
          : await readBranchHeadEventSeq(env.R2_BUCKET, id, branch.branchId);
      const response: DropDiffPollResponse = {
        events: [],
        cursor: maxSeq >= 0 ? String(maxSeq) : null,
      };

      logger.logEnd(200, {
        dropRef: toLogRef(id),
        branchRef: toLogRef(branch.branchId),
        returned: 0,
        totalStored: maxSeq + 1,
      });

      return jsonResponse(response);
    }

    const afterSeq =
      cursorParam !== null ? Number.parseInt(cursorParam, 10) : -1;
    const excludeClient = query.excludeClient;
    const limit = query.limit ?? DEFAULT_POLL_LIMIT;

    const branch = await resolveBranchForDiffRequest(env, id, request, {
      mode: "none",
      branchId: resolveRequestedBranchId(request),
      clientId: sanitizeDiffAuthToken(excludeClient),
    });

    const page = await pollBranchDiffEventsSince(
      env.R2_BUCKET,
      id,
      branch.branchId,
      afterSeq,
      limit,
      excludeClient,
    );
    const nextCursor =
      page.nextCursor !== null ? String(page.nextCursor) : null;

    const response: DropDiffPollResponse = {
      events: page.events,
      cursor: nextCursor,
    };

    logger.logEnd(200, {
      dropRef: toLogRef(id),
      branchRef: toLogRef(branch.branchId),
      returned: page.events.length,
      totalStored: page.headSeq + 1,
    });

    return jsonResponse(response);
  } catch (error: unknown) {
    if (isApiHttpError(error)) {
      logger.logEnd(error.status, {
        reason: error.code,
        requestedDropRef: toLogRef(requestedId),
      });
      return apiHttpErrorResponse(error);
    }

    logger.logError("diff.get.unhandled_error", error, {
      requestedDropRef: toLogRef(requestedId),
    });
    logger.logEnd(500, { reason: "unhandled_error" });
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Failed to read diffs: ${message}`, { status: 500 });
  }
};

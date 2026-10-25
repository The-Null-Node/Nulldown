/*
`/api/diff/:id` is the live branch editing transport. It accepts append-only diff events,
resolves the caller to the correct branch, and supports three auth modes: provider-issued
branch credentials, an environment webhook secret, or unauthenticated local development.
*/

import { z } from "zod";
import { unobserved, type Timing } from "../../core/observability/profiling";
import { type DropDiffAppendResponse } from "../../../../../shared/drop/diff";
import {
  DIFF_TOKEN_MAX_LENGTH,
  DropDiffAppendEnvelopeSchema,
} from "../../../../../shared/drop/codecs/diff-v1";
import { sanitizeDiffAuthToken } from "../credentials/repository";
import {
  verifyDiffRequestAuth,
  type DiffRequestAuthSuccess,
} from "../credentials/request-auth";
import {
  resolveAuthenticatedAccountId,
  type AccountAuthEnv,
} from "../../accounts/session/authentication";
import { type DropBranchRecord } from "../../../../../shared/drop/branch";
import { BranchMutationLockError } from "../../branches/storage/mutation-lock";
import {
  createBranchStatePlane,
  createDiffCommandStatePlane,
} from "../../../../../src/server/state-plane/gateway";
import { createDropIdentityRepository } from "../../drops/identity/id";
import {
  canReadBranch,
  canReadSensitiveBranch,
  resolveRootReadAuthorization,
} from "../../security/read-authorization";
import type { NulldownServerRuntime } from "../../../../../src/server/runtime";
import type {
  BlobObjectStore,
  SqlMetadataStore,
} from "../../../../../src/server/ports";
import { createRequestLogger, toLogRef } from "../../core/logging/logger";
import {
  apiHttpErrorResponse,
  isApiHttpError,
  ApiHttpError,
  jsonErrorResponse,
  jsonResponse,
  parseJsonTextWithSchema,
  parseWithSchema,
  readRequestTextWithLimit,
  type JsonValue,
} from "../../core/http/responses";

/** Environment required by the diff transport service. */
export interface DiffTransportEnv extends AccountAuthEnv {
  R2_BUCKET: BlobObjectStore;
  DB?: SqlMetadataStore;
  DIFF_WEBHOOK_SECRET?: string;
  DIFF_AUTH_MAX_SKEW_MS?: string;
  PROVIDER_ENCRYPTION_PRIVATE_JWK?: string;
}

/** Route parameters passed from the `/api/diff/:id` adapter. */
export interface DiffTransportParams {
  id: string | string[];
}

/** Composed runtime services required by diff POST transport. */
export interface DiffTransportServices {
  /** Backend server runtime used to append and snapshot branch diffs. */
  serverRuntime: NulldownServerRuntime;
  /** Optional platform scheduler for async snapshotter work. */
  waitUntil?: (promise: Promise<void>) => void;
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
    factCursor: z
      .union([z.literal("__latest__"), z.string().regex(/^-?\d+$/)])
      .optional(),
    factLimit: z
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
  if (
    branchId !== null &&
    (!branchId ||
      branchId !== sanitizeDiffAuthToken(branchId) ||
      url.searchParams.getAll("branchId").length !== 1)
  ) {
    throw new ApiHttpError({
      status: 400,
      code: "branch_target_invalid",
      message: "Supply one exact, nonempty branchId.",
    });
  }
  return sanitizeDiffAuthToken(branchId);
};

const parseDiffPollQuery = (request: Request): DiffPollQuery => {
  const url = new URL(request.url);
  const query: { [key: string]: JsonValue } = {
    cursor: url.searchParams.get("cursor"),
  };
  const excludeClient = url.searchParams.get("excludeClient");
  const limit = url.searchParams.get("limit");
  const factCursor = url.searchParams.get("factCursor");
  const factLimit = url.searchParams.get("factLimit");

  if (excludeClient !== null) {
    query.excludeClient = excludeClient;
  }
  if (limit !== null) {
    query.limit = limit;
  }
  if (factCursor !== null) {
    query.factCursor = factCursor;
  }
  if (factLimit !== null) {
    query.factLimit = factLimit;
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
  const requestedBranchId = resolveRequestedBranchId(request);
  if (
    auth.branchId &&
    requestedBranchId &&
    auth.branchId !== requestedBranchId
  ) {
    throw new ApiHttpError({
      status: 403,
      code: "branch_target_mismatch",
      message: "The requested branch does not match the branch credential.",
    });
  }
  const statePlane = createBranchStatePlane({
    blobs: env.R2_BUCKET,
    sql: env.DB,
    providerPrivateKey: env.PROVIDER_ENCRYPTION_PRIVATE_JWK,
  });
  if (auth.branchId) {
    const branch = await statePlane.branches.readBranch(dropId, auth.branchId);
    if (!branch) {
      throw new ApiHttpError({
        status: 404,
        code: "branch_not_found",
        message: "Branch not found.",
      });
    }
    return branch;
  }

  const accountId = await resolveAuthenticatedAccountId(request, env);
  if (requestedBranchId) {
    const branch = await statePlane.branches.readBranch(
      dropId,
      requestedBranchId,
    );
    if (branch) {
      return branch;
    }
    throw new ApiHttpError({
      status: 404,
      code: "branch_not_found",
      message: "Branch not found.",
    });
  }

  const resolved = await statePlane.branches.resolveForActor(
    dropId,
    accountId,
    auth.clientId,
  );
  return resolved.branch;
};

const canWriteBranch = (
  branch: DropBranchRecord,
  accountId: string | null,
): boolean =>
  Boolean(
    accountId &&
    (accountId === branch.ownerAccountId ||
      accountId === branch.writerAccountId),
  );

/** Appends posted diff events to the resolved branch. */
export const postDiffEvents = async (
  env: DiffTransportEnv,
  params: DiffTransportParams,
  request: Request,
  services: DiffTransportServices,
  timing: Timing = unobserved,
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

    const dropIdentityRepository = createDropIdentityRepository({
      blobs: env.R2_BUCKET,
      sql: env.DB,
    });
    const id = await timing.phase("diff.identity", () =>
      dropIdentityRepository.resolveRemoteDropId(requestedId, logger),
    );
    if (!id) {
      logger.logEnd(400, { reason: "invalid_drop_id" });
      return new Response("Drop ID is required.", { status: 400 });
    }

    const rawBody = await timing.phase("diff.body", () =>
      readRequestTextWithLimit(request, DIFF_REQUEST_BODY_MAX_BYTES),
    );

    const auth = await timing.phase("diff.auth", () =>
      verifyDiffRequestAuth(env, request, id, rawBody),
    );
    if (!auth.ok) {
      logger.logEnd(auth.status, {
        reason: auth.reason,
        requestedDropRef: toLogRef(requestedId),
        dropRef: toLogRef(id),
      });
      return new Response(auth.message, { status: auth.status });
    }

    const parsed = timing.sync("diff.validate", () =>
      parseJsonTextWithSchema(
        rawBody,
        DropDiffAppendEnvelopeSchema,
        "Invalid diff envelope.",
      ),
    );

    const branch = await timing.phase("diff.branch", () =>
      resolveBranchForDiffRequest(env, id, request, auth),
    );

    if (auth.mode === "account") {
      const accountId = await timing.phase("diff.authority", () =>
        resolveAuthenticatedAccountId(request, env),
      );
      if (!canWriteBranch(branch, accountId)) {
        logger.logEnd(403, {
          reason: "branch_write_forbidden",
          dropRef: toLogRef(id),
          branchRef: toLogRef(branch.branchId),
        });
        return jsonErrorResponse(
          403,
          "branch_write_forbidden",
          "You are not allowed to write to this branch.",
        );
      }
    }

    const mismatch = parsed.events.find((event) => event.dropId !== id);
    if (mismatch) {
      logger.logEnd(400, { reason: "drop_id_mismatch", dropRef: toLogRef(id) });
      return new Response("Event dropId does not match route.", {
        status: 400,
      });
    }

    const commands = createDiffCommandStatePlane(
      services.serverRuntime.nulledit,
    );
    const appended = await timing.phase("diff.append", () =>
      commands.appendDiffEvents({
        branch,
        events: parsed.events,
        waitUntil: services.waitUntil,
        onSnapshotterError: (error, snapshotterId) => {
          logger.logError("diff.nulledit_snapshotter_failed", error, {
            snapshotterId,
            dropRef: toLogRef(id),
            branchRef: toLogRef(branch.branchId),
          });
        },
      }),
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

    return timing.sync("diff.serialize", () =>
      jsonResponse({
        accepted: appended.acceptedEvents.length,
        deduplicated: appended.deduplicatedCount,
        branchId: branch.branchId,
        snapshotId,
        totalStored: appended.totalStored,
        acknowledgements: appended.acknowledgements,
      } satisfies DropDiffAppendResponse),
    );
  } catch (error: unknown) {
    if (isApiHttpError(error)) {
      logger.logEnd(error.status, {
        reason: error.code,
        requestedDropRef: toLogRef(requestedId),
      });
      return apiHttpErrorResponse(error);
    }

    if (error instanceof BranchMutationLockError) {
      const status =
        error.code === "branch_lock_timeout"
          ? 503
          : error.outcome === "not_committed"
            ? 409
            : 503;
      const message =
        error.code === "branch_lock_timeout"
          ? "Branch is busy. Retry shortly."
          : error.outcome === "not_committed"
            ? "Branch lock was not held before commit. Refresh and retry."
            : "Branch mutation outcome could not be confirmed. Retry the exact same event.";
      logger.logEnd(status, { reason: error.code });
      return jsonErrorResponse(status, error.code, message);
    }

    const message = error instanceof Error ? error.message : String(error);

    if (message === "branch_lock_timeout") {
      logger.logEnd(409, { reason: "branch_busy" });
      return new Response("Branch is busy. Retry shortly.", { status: 409 });
    }

    if (message === "diff_predecessor_mismatch") {
      logger.logEnd(409, { reason: message });
      return jsonErrorResponse(
        409,
        message,
        "Branch diff predecessor no longer matches the current head. Refresh and try again.",
      );
    }

    if (message === "diff_sequence_exhausted") {
      logger.logEnd(409, { reason: message });
      return jsonErrorResponse(
        409,
        message,
        "Branch diff sequence capacity is exhausted. Start a new branch.",
      );
    }

    if (message === "diff_event_id_reused") {
      logger.logEnd(409, { reason: message });
      return new Response(
        "A diff event id was already used for different event data.",
        { status: 409 },
      );
    }

    if (message === "diff_event_ack_missing") {
      logger.logEnd(500, { reason: message });
      return new Response("Stored diff event acknowledgement is missing.", {
        status: 500,
      });
    }

    if (message === "diff_event_outcome_unknown") {
      logger.logEnd(503, { reason: message });
      return jsonErrorResponse(
        503,
        message,
        "Diff commit outcome could not be confirmed. Retry the exact same event.",
      );
    }

    if (message === "diff_event_identity_invalid") {
      logger.logEnd(500, { reason: message });
      return jsonErrorResponse(
        500,
        message,
        "Stored diff event identity is inconsistent. Do not retry with a new event.",
      );
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

    const dropIdentityRepository = createDropIdentityRepository({
      blobs: env.R2_BUCKET,
      sql: env.DB,
    });
    const id = await dropIdentityRepository.resolveRemoteDropIdForReadRequest(
      requestedId,
      logger,
    );
    if (!id) {
      logger.logEnd(400, { reason: "invalid_drop_id" });
      return new Response("Drop ID is required.", { status: 400 });
    }

    const authorization = await resolveRootReadAuthorization(request, env, id);
    if (authorization.kind === "denied") {
      logger.logEnd(404, {
        reason: "branch_not_found",
        dropRef: toLogRef(id),
      });
      return new Response("Branch not found.", { status: 404 });
    }

    const query = parseDiffPollQuery(request);
    const cursorParam = query.cursor;
    const factCursorParam = query.factCursor;
    const branch = await resolveBranchForDiffRequest(env, id, request, {
      mode: "none",
      branchId: resolveRequestedBranchId(request),
      clientId: sanitizeDiffAuthToken(query.excludeClient ?? null),
    });
    if (!canReadBranch(authorization, branch)) {
      logger.logEnd(404, {
        reason: "branch_not_found",
        dropRef: toLogRef(id),
      });
      return new Response("Branch not found.", { status: 404 });
    }

    if (
      factCursorParam !== undefined &&
      !(await canReadSensitiveBranch(request, env, id, branch))
    ) {
      logger.logEnd(403, {
        reason: "runtime_fact_read_forbidden",
        dropRef: toLogRef(id),
        branchRef: toLogRef(branch.branchId),
      });
      return new Response(
        "You are not allowed to read runtime facts for this branch.",
        { status: 403 },
      );
    }

    const statePlane = createBranchStatePlane({
      blobs: env.R2_BUCKET,
      sql: env.DB,
    });
    const polled = await statePlane.diffs.poll({
      rootDropId: id,
      branch,
      cursor: cursorParam,
      excludeClient: query.excludeClient,
      limit: query.limit ?? DEFAULT_POLL_LIMIT,
      factCursor: factCursorParam,
      factLimit: query.factLimit ?? DEFAULT_POLL_LIMIT,
    });
    const response = polled.response;

    if (cursorParam === "__latest__") {
      logger.logEnd(200, {
        dropRef: toLogRef(id),
        branchRef: toLogRef(branch.branchId),
        returned: 0,
        totalStored: polled.totalStored,
        totalFacts: polled.totalFacts,
      });

      return jsonResponse(response);
    }

    logger.logEnd(200, {
      dropRef: toLogRef(id),
      branchRef: toLogRef(branch.branchId),
      returned: response.events.length,
      totalStored: polled.totalStored,
      returnedFacts: response.facts?.length ?? 0,
      totalFacts: polled.totalFacts,
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

import { z } from "zod";
import { toShortDropId } from "../../../../../shared/drop/id";
import type {
  DropBranchPromoteRequest,
  DropBranchPromoteResponse,
} from "../../../../../shared/drop/branch";
import type { VoidBlobStore, VoidSqlStore } from "../../../../../src/server/ports";
import {
  resolveAuthenticatedAccountId,
  type AccountAuthEnv,
} from "../../accounts/session/auth";
import { readBranchContent } from "../content/replay";
import { createBranchRepository } from "../storage/repository";
import {
  completeBranchPromotionReceipt,
  createBranchPromotionReceipt,
  readBranchPromotionReceipt,
  type BranchPromotionReceipt,
} from "../storage/promotionReceiptRepository";
import {
  BranchMutationLockError,
  withBranchMutationLock,
} from "../storage/mutationLock";
import { sanitizeDiffAuthToken } from "../../diffs/credentials/repository";
import { createDropIdentityRepository } from "../../drops/identity/id";
import {
  apiHttpErrorResponse,
  isApiHttpError,
  jsonErrorResponse,
  readJsonBodyWithSchema,
  resolveParam,
} from "../../core/http/responses";
import { createPromotedEnvelope } from "../../crypto/envelopes/promotion";
import {
  createReservedRemoteJsonDrop,
  releaseReservedRemoteJsonDropId,
  reserveRemoteJsonDropId,
} from "../../drops/storage/remoteCreate";

const PROMOTION_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const PROMOTION_REQUEST_MAX_BYTES = 1024;

const promotionRequestSchema = z
  .object({
    expectedSnapshotId: z.number().int().min(0),
    idempotencyKey: z.string().regex(PROMOTION_IDEMPOTENCY_KEY_PATTERN),
  })
  .strict();

const createPromotionResponse = (
  receipt: BranchPromotionReceipt,
  publicBaseUrl: string,
): DropBranchPromoteResponse => ({
  dropId: receipt.promotedDropId,
  url: `${publicBaseUrl.replace(/\/$/, "")}/d/${toShortDropId(receipt.promotedDropId)}`,
  rootDropId: receipt.rootDropId,
  branchId: receipt.branchId,
  snapshotId: receipt.expectedSnapshotId,
});

const hasMatchingPromotionIdentity = (
  receipt: BranchPromotionReceipt,
  request: DropBranchPromoteRequest,
): boolean => receipt.expectedSnapshotId === request.expectedSnapshotId;

/** Environment required to promote a branch snapshot into a new drop. */
export interface BranchPromotionEnv extends AccountAuthEnv {
  R2_BUCKET: VoidBlobStore;
  DB?: VoidSqlStore;
  PUBLIC_BASE_URL: string;
  PROVIDER_ENCRYPTION_PRIVATE_JWK?: string;
  PROVIDER_SIGNING_PRIVATE_JWK?: string;
}

/** Route parameters accepted by the branch promotion service. */
export interface BranchPromotionParams {
  rootId: string | string[];
  branchId: string | string[];
}

/** Promotes one fenced branch snapshot into a retry-safe remote drop. */
export const promoteBranchSnapshot = async (
  env: BranchPromotionEnv,
  params: BranchPromotionParams,
  request: Request,
): Promise<Response> => {
  if (!env.R2_BUCKET) {
    return new Response("R2 bucket binding is required.", { status: 500 });
  }
  if (!env.PUBLIC_BASE_URL) {
    return new Response("PUBLIC_BASE_URL environment variable is required.", {
      status: 500,
    });
  }

  try {
    const promotion = await readJsonBodyWithSchema(request, promotionRequestSchema, {
      maxBytes: PROMOTION_REQUEST_MAX_BYTES,
      validationMessage: "Invalid branch promotion request.",
    });
    const dropIdentityRepository = createDropIdentityRepository({
      blobs: env.R2_BUCKET,
      sql: env.DB,
    });
    const rootDropId = await dropIdentityRepository.resolveRemoteDropId(
      resolveParam(params.rootId),
    );
    const branchId = sanitizeDiffAuthToken(resolveParam(params.branchId));
    const accountId = await resolveAuthenticatedAccountId(request, env);
    if (!rootDropId || !branchId) {
      return jsonErrorResponse(
        400,
        "promotion_target_invalid",
        "Root drop ID and branch ID are required.",
      );
    }
    if (!accountId) {
      return jsonErrorResponse(401, "account_required", "Account ID is required.");
    }

    const branchRepository = createBranchRepository({
      blobs: env.R2_BUCKET,
      sql: env.DB,
    });
    const result = await withBranchMutationLock(
      env.R2_BUCKET,
      rootDropId,
      branchId,
      async (lock) => {
        const branch = await branchRepository.readBranch(rootDropId, branchId);
        if (!branch) {
          throw new PromotionHttpError(404, "branch_not_found", "Branch not found.");
        }
        if (
          accountId !== branch.ownerAccountId &&
          accountId !== branch.writerAccountId
        ) {
          throw new PromotionHttpError(
            403,
            "promotion_forbidden",
            "You are not allowed to promote this branch.",
          );
        }

        const receiptIdentity = {
          rootDropId,
          branchId,
          actorAccountId: accountId,
          idempotencyKey: promotion.idempotencyKey,
        };
        const existing = await readBranchPromotionReceipt(
          env.R2_BUCKET,
          receiptIdentity,
        );
        if (existing) {
          if (!hasMatchingPromotionIdentity(existing, promotion)) {
            throw new PromotionHttpError(
              409,
              "promotion_idempotency_mismatch",
              "This promotion key was already used for a different snapshot.",
            );
          }
          if (existing.status === "completed") {
            return existing;
          }

          return finalizePendingPromotionReceipt(env, lock, existing);
        }

        if (branch.headSnapshotId !== promotion.expectedSnapshotId) {
          throw new PromotionHttpError(
            409,
            "promotion_head_mismatch",
            "Branch head changed before promotion. Refresh and retry with the current snapshot.",
            {
              expectedSnapshotId: promotion.expectedSnapshotId,
              actualSnapshotId: branch.headSnapshotId,
            },
          );
        }

        const content = await readBranchContent(
          env.R2_BUCKET,
          rootDropId,
          branchId,
          promotion.expectedSnapshotId,
          env.DB,
        );
        if (content === null) {
          throw new PromotionHttpError(
            404,
            "promotion_snapshot_not_found",
            "Branch content not found.",
          );
        }

        const promotedMetadata = {
          ownerAccountId: branch.ownerAccountId,
          baseDropId: rootDropId,
          rootDropId,
          branchId,
          snapshotId: promotion.expectedSnapshotId,
          promotedFromBranchId: branchId,
        };
        const providerEncryptionPrivateJwk = env.PROVIDER_ENCRYPTION_PRIVATE_JWK;
        const providerSigningPrivateJwk = env.PROVIDER_SIGNING_PRIVATE_JWK;
        const promotedPayload = (typeof providerEncryptionPrivateJwk === "string" &&
        typeof providerSigningPrivateJwk === "string"
          ? await createPromotedEnvelope({
              content,
              accountId: branch.writerAccountId ?? branch.ownerAccountId ?? accountId,
              metadata: promotedMetadata,
              providerEncryptionPrivateJwk,
              providerSigningPrivateJwk,
            })
          : { content, metadata: promotedMetadata }) as Record<string, unknown>;

        await lock.beginCommit();
        const promotedDropId = await reserveRemoteJsonDropId(env.R2_BUCKET, env.DB);
        const receipt: BranchPromotionReceipt = {
          version: 1,
          ...receiptIdentity,
          expectedSnapshotId: promotion.expectedSnapshotId,
          promotedDropId,
          promotedPayload,
          status: "pending",
          createdAt: Date.now(),
        };
        let receiptCreated = false;
        try {
          receiptCreated = await createBranchPromotionReceipt(env.R2_BUCKET, receipt);
        } catch (error) {
          const persisted = await readBranchPromotionReceipt(env.R2_BUCKET, receiptIdentity);
          if (!persisted) {
            await releaseReservedRemoteJsonDropId(env.R2_BUCKET, promotedDropId, env.DB);
          }
          throw error;
        }
        if (!receiptCreated) {
          const raced = await readBranchPromotionReceipt(env.R2_BUCKET, receiptIdentity);
          await releaseReservedRemoteJsonDropId(env.R2_BUCKET, promotedDropId, env.DB);
          if (!raced || !hasMatchingPromotionIdentity(raced, promotion)) {
            throw new Error("promotion_receipt_race_unconfirmed");
          }
          return raced.status === "completed"
            ? raced
            : finalizePendingPromotionReceipt(env, lock, raced);
        }

        await createReservedRemoteJsonDrop(
          env.R2_BUCKET,
          receipt.promotedDropId,
          receipt.promotedPayload,
          env.DB,
        );
        return completeBranchPromotionReceipt(env.R2_BUCKET, receipt);
      },
    );

    return new Response(JSON.stringify(createPromotionResponse(result, env.PUBLIC_BASE_URL)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    if (error instanceof PromotionHttpError) {
      return jsonErrorResponse(error.status, error.code, error.message, error.details);
    }
    if (isApiHttpError(error)) return apiHttpErrorResponse(error);
    if (error instanceof BranchMutationLockError) {
      const timedOut = error.code === "branch_lock_timeout";
      return jsonErrorResponse(
        timedOut ? 503 : error.outcome === "not_committed" ? 409 : 503,
        error.code,
        timedOut
          ? "Branch is busy. Retry the exact same idempotency key."
          : error.outcome === "not_committed"
          ? "Branch changed before promotion could commit. Refresh and retry."
          : "Promotion outcome could not be confirmed. Retry the exact same idempotency key.",
      );
    }
    const message = error instanceof Error ? error.message : "Branch promotion failed.";
    return jsonErrorResponse(500, "promotion_failed", message);
  }
};

class PromotionHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: object,
  ) {
    super(message);
  }
}

const finalizePendingPromotionReceipt = async (
  env: BranchPromotionEnv,
  lock: { beginCommit(): Promise<void> },
  receipt: BranchPromotionReceipt,
): Promise<BranchPromotionReceipt> => {
  await lock.beginCommit();
  await createReservedRemoteJsonDrop(
    env.R2_BUCKET,
    receipt.promotedDropId,
    receipt.promotedPayload,
    env.DB,
  );
  return completeBranchPromotionReceipt(env.R2_BUCKET, receipt);
};

import { z } from "zod";
import type { DropBranchPublishResponse } from "../../../../shared/drop/branch";
import {
  decodeDropEnvelope,
  encodeDropEnvelope,
} from "../../../../shared/drop/codecs/envelope-v1";
import { isDropPayload } from "../../../../shared/drop/codecs/draft-pack-v1";
import { toShortDropId } from "../../../../shared/drop/id";
import { resolveAuthenticatedAccountId } from "../accounts/session/authentication";
import {
  readAccountLibraryEntry,
  upsertAccountLibraryEntry,
} from "../accounts/library/repository";
import { projectAccountLibraryEnvelope } from "../accounts/library/service";
import {
  ApiHttpError,
  apiHttpErrorResponse,
  isApiHttpError,
  jsonErrorResponse,
  jsonResponse,
  readJsonBodyWithSchema,
  resolveParam,
} from "../core/http/responses";
import { createRequestLogger, toLogRef } from "../core/logging/logger";
import { sealPublishedEnvelope } from "../crypto/envelopes/publication";
import { createDropIdentityRepository } from "../drops/identity/id";
import { syncPublicDropIndexForEnvelope } from "../drops/index/repository";
import {
  acquireRootMutationLock,
  RootMutationLockError,
} from "../drops/storage/mutation-lock";
import { readBranchContent } from "./content/replay";
import { assertOwnerRootHistory, readRootDropState } from "./lifecycle";
import type { BranchPromotionEnv, BranchPromotionParams } from "./promotion";
import {
  withBranchMutationLock,
  BranchMutationLockError,
} from "./storage/mutation-lock";
import { createBranchRepository } from "./storage/repository";
import {
  readPublicationReceipt,
  writePublicationReceipt,
  type BranchPublicationReceipt,
} from "./storage/publication-receipt";

const schema = z
  .object({
    expectedSnapshotId: z.number().int().nonnegative().safe(),
    expectedRevision: z.string().trim().min(1).max(256),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/),
  })
  .strict();
const revision = (value: string): string => value.replace(/^"|"$/g, "");
const fail = (status: number, code: string, message: string): never => {
  throw new ApiHttpError({ status, code, message });
};

/** Publishes an owner snapshot to its existing root, under root-then-branch leases. */
export const publishOwnerSnapshot = async (
  env: BranchPromotionEnv,
  params: BranchPromotionParams,
  request: Request,
): Promise<Response> => {
  const logger = createRequestLogger({
    request,
    env,
    route: "/api/branches/:rootId/:branchId/publish",
  });
  const logEnd = (status: number, fields: Record<string, unknown>): void => {
    try {
      logger.logEnd(status, fields);
    } catch {
      /* Telemetry cannot change a publication outcome. */
    }
  };
  let operationRef: string | undefined;
  try {
    const input = await readJsonBodyWithSchema(request, schema, {
      maxBytes: 2048,
      validationMessage: "Invalid publication request.",
    });
    operationRef = toLogRef(input.idempotencyKey);
    const accountId = await resolveAuthenticatedAccountId(request, env);
    if (!accountId)
      return fail(
        401,
        "account_required",
        "An authenticated owner is required.",
      );
    if (resolveParam(params.branchId) !== "owner")
      return fail(
        403,
        "publication_owner_branch_required",
        "Only the owner branch can publish to its root.",
      );
    if (!env.DB)
      return fail(
        503,
        "account_library_unavailable",
        "Verified root ownership is unavailable.",
      );
    const rootDropId = await createDropIdentityRepository({
      blobs: env.R2_BUCKET,
      sql: env.DB,
    }).resolveRemoteDropId(resolveParam(params.rootId));
    if (!rootDropId) return fail(404, "drop_not_found", "Drop not found.");
    const rootLock = await acquireRootMutationLock(env.R2_BUCKET, rootDropId);
    try {
      const result = await withBranchMutationLock(
        env.R2_BUCKET,
        rootDropId,
        "owner",
        async (branchLock) => {
          const ownership = await readAccountLibraryEntry(env.DB!, rootDropId);
          if (
            !ownership ||
            ownership.deleted_at !== null ||
            ownership.account_id !== accountId
          )
            return fail(
              403,
              "publication_forbidden",
              "Verified root ownership is required.",
            );
          const branch = await createBranchRepository({
            blobs: env.R2_BUCKET,
            sql: env.DB,
          }).readBranch(rootDropId, "owner");
          if (
            !branch ||
            branch.mode !== "owner" ||
            branch.ownerAccountId !== accountId
          )
            return fail(
              403,
              "publication_forbidden",
              "The owner branch is unavailable for this account.",
            );
          const object = await env.R2_BUCKET.get(rootDropId);
          if (!object) return fail(404, "drop_not_found", "Drop not found.");
          const currentText = await object.text();
          const currentRevision = revision(
            object.etag ?? object.httpEtag ?? "",
          );
          if (!currentRevision)
            return fail(
              503,
              "root_revision_unavailable",
              "Root revision is unavailable.",
            );
          const identity = {
            rootDropId,
            actorAccountId: accountId,
            idempotencyKey: input.idempotencyKey,
          };
          let receipt = await readPublicationReceipt(env.R2_BUCKET, identity);
          if (receipt) {
            if (
              receipt.expectedSnapshotId !== input.expectedSnapshotId ||
              receipt.expectedRevision !== revision(input.expectedRevision)
            )
              return fail(
                409,
                "publication_idempotency_mismatch",
                "Reuse the original snapshot and revision with this key.",
              );
            if (receipt.status === "completed") return receipt;
          } else {
            if (branch.headSnapshotId !== input.expectedSnapshotId)
              return fail(
                409,
                "publication_head_mismatch",
                "Branch head changed. Refresh before publishing.",
              );
            if (currentRevision !== revision(input.expectedRevision))
              return fail(
                409,
                "publication_revision_mismatch",
                "Root changed. Refresh before publishing.",
              );
            const rootState = await readRootDropState(
              env.R2_BUCKET,
              rootDropId,
              env.PROVIDER_ENCRYPTION_PRIVATE_JWK,
            );
            if (!rootState)
              return fail(
                409,
                "publication_root_unavailable",
                "Root content cannot be materialized.",
              );
            await assertOwnerRootHistory(env.R2_BUCKET, rootState, env.DB);
            const content = await readBranchContent(
              env.R2_BUCKET,
              rootDropId,
              "owner",
              input.expectedSnapshotId,
              env.DB,
            );
            if (content === null)
              return fail(
                404,
                "snapshot_not_found",
                "Snapshot content is unavailable.",
              );
            const original: unknown = JSON.parse(currentText);
            const envelope = decodeDropEnvelope(original);
            const metadata = {
              ...(envelope?.metadata ??
                (isDropPayload(original) ? original.metadata : {})),
              ownerPublication: {
                rootDropId,
                branchId: "owner",
                snapshotId: input.expectedSnapshotId,
                idempotencyKey: input.idempotencyKey,
              },
            };
            let payload: string;
            if (envelope) {
              if (envelope.accountId !== accountId)
                return fail(
                  403,
                  "publication_forbidden",
                  "Root ownership does not match.",
                );
              if (
                envelope.unlockPolicy !== "provider-escrow" ||
                !envelope.providerEscrow
              )
                return fail(
                  409,
                  "publication_escrow_required",
                  "This root cannot be published by the server.",
                );
              if (
                !env.PROVIDER_ENCRYPTION_PRIVATE_JWK ||
                !env.PROVIDER_SIGNING_PRIVATE_JWK
              )
                return fail(
                  503,
                  "publication_crypto_unavailable",
                  "Publication keys are unavailable.",
                );
              payload = JSON.stringify(
                encodeDropEnvelope(
                  await sealPublishedEnvelope(
                    envelope,
                    content,
                    metadata,
                    env.PROVIDER_ENCRYPTION_PRIVATE_JWK,
                    env.PROVIDER_SIGNING_PRIVATE_JWK,
                  ),
                ),
              );
            } else {
              if (!isDropPayload(original))
                return fail(
                  409,
                  "publication_root_invalid",
                  "Unsupported root format.",
                );
              payload = JSON.stringify({ content, metadata });
            }
            receipt = {
              version: 1,
              ...identity,
              branchId: "owner",
              expectedSnapshotId: input.expectedSnapshotId,
              expectedRevision: currentRevision,
              payload,
              status: "pending",
              createdAt: Date.now(),
            };
            await rootLock.beginCommit();
            await branchLock.beginCommit();
            await writePublicationReceipt(env.R2_BUCKET, receipt, true);
          }
          // Lost response after the root write: finish the exact receipt, never
          // reseal or overwrite a later root with the old publication.
          let publishedRevision = currentRevision;
          if (currentText !== receipt.payload) {
            if (currentRevision !== receipt.expectedRevision)
              return fail(
                409,
                "publication_revision_mismatch",
                "Root changed while publication was pending.",
              );
            await rootLock.beginCommit();
            await branchLock.beginCommit();
            const stored = await env.R2_BUCKET.put(
              rootDropId,
              receipt.payload,
              {
                onlyIf: { etagMatches: receipt.expectedRevision },
                httpMetadata: { contentType: "application/json" },
              },
            );
            if (!stored)
              return fail(
                409,
                "publication_revision_mismatch",
                "Root changed before publication committed.",
              );
            publishedRevision = revision(stored.etag ?? stored.httpEtag ?? "");
            if (!publishedRevision)
              throw new Error("publication_revision_unavailable");
          }
          const publishedEnvelope = decodeDropEnvelope(
            JSON.parse(receipt.payload),
          );
          await syncPublicDropIndexForEnvelope(
            env.R2_BUCKET,
            rootDropId,
            publishedEnvelope,
            receipt.createdAt,
            env.DB,
          );
          if (publishedEnvelope)
            await projectAccountLibraryEnvelope(
              env.DB!,
              rootDropId,
              accountId,
              publishedEnvelope,
              receipt.createdAt,
            );
          else
            await upsertAccountLibraryEntry(env.DB!, {
              dropId: rootDropId,
              accountId,
              visibility: ownership.visibility,
              createdAt: ownership.created_at,
              updatedAt: receipt.createdAt,
            });
          await env
            .DB!.prepare(
              "UPDATE drops SET updated_at = ?, metadata_json = ? WHERE id = ? AND owner_account_id = ?",
            )
            .bind(
              receipt.createdAt,
              JSON.stringify(
                (JSON.parse(receipt.payload) as { metadata?: unknown })
                  .metadata ?? {},
              ),
              rootDropId,
              accountId,
            )
            .run();
          const completed: BranchPublicationReceipt = {
            ...receipt,
            status: "completed",
            revision: publishedRevision,
          };
          await rootLock.beginCommit();
          await branchLock.beginCommit();
          await writePublicationReceipt(env.R2_BUCKET, completed);
          return completed;
        },
      );
      const response: DropBranchPublishResponse = {
        outcome: "root-published",
        dropId: rootDropId,
        rootDropId,
        branchId: "owner",
        snapshotId: result.expectedSnapshotId,
        revision: `"${result.revision}"`,
        url: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/d/${toShortDropId(rootDropId)}`,
      };
      logEnd(200, {
        outcome: response.outcome,
        operationRef,
        rootRef: toLogRef(rootDropId),
        actorRef: toLogRef(accountId),
        snapshotId: response.snapshotId,
      });
      return jsonResponse(response);
    } finally {
      await rootLock.release();
    }
  } catch (error) {
    if (isApiHttpError(error)) {
      logEnd(error.status, {
        outcome: "rejected",
        reason: error.code,
        operationRef,
      });
      return apiHttpErrorResponse(error);
    }
    const reason =
      error instanceof RootMutationLockError ||
      error instanceof BranchMutationLockError
        ? error.code
        : "publication_unconfirmed";
    logEnd(503, { outcome: "unconfirmed", reason, operationRef });
    return jsonErrorResponse(
      503,
      reason,
      "Publication could not be confirmed. Retry the exact same request.",
    );
  }
};

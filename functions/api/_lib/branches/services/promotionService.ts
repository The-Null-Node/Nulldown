import { toShortDropId } from "../../../../../shared/drop/id";
import type { VoidBlobStore, VoidSqlStore } from "../../../../../src/server/ports";
import {
  resolveAuthenticatedAccountId,
  type AccountAuthEnv,
} from "../../accounts/session/auth";
import { readBranchContent } from "../content/replay";
import { readBranch } from "../storage/repository";
import { sanitizeDiffAuthToken } from "../../diffs/credentials/repository";
import { resolveRemoteDropId } from "../../drops/identity/id";
import { resolveParam } from "../../core/http/responses";
import { createPromotedEnvelope } from "../../crypto/envelopes/promotion";
import { createRemoteJsonDrop } from "../../drops/storage/remoteCreate";

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

/** Promotes a branch head snapshot into a new remote drop. */
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

  const rootDropId = await resolveRemoteDropId(
    env.R2_BUCKET,
    resolveParam(params.rootId),
    undefined,
    env.DB,
  );
  const branchId = sanitizeDiffAuthToken(resolveParam(params.branchId));
  const accountId = await resolveAuthenticatedAccountId(request, env);
  if (!rootDropId || !branchId) {
    return new Response("Root drop ID and branch ID are required.", {
      status: 400,
    });
  }
  if (!accountId) {
    return new Response("Account ID is required.", { status: 401 });
  }

  const branch = await readBranch(env.R2_BUCKET, rootDropId, branchId, env.DB);
  if (!branch) {
    return new Response("Branch not found.", { status: 404 });
  }

  const canPromote =
    accountId === branch.ownerAccountId || accountId === branch.writerAccountId;
  if (!canPromote) {
    return new Response("You are not allowed to promote this branch.", {
      status: 403,
    });
  }

  const content = await readBranchContent(
    env.R2_BUCKET,
    rootDropId,
    branchId,
    branch.headSnapshotId,
    env.DB,
  );
  if (content === null) {
    return new Response("Branch content not found.", { status: 404 });
  }

  const promotedMetadata = {
    ownerAccountId: branch.ownerAccountId,
    baseDropId: rootDropId,
    rootDropId,
    branchId,
    snapshotId: branch.headSnapshotId,
    promotedFromBranchId: branchId,
  };

  const providerEncryptionPrivateJwk = env.PROVIDER_ENCRYPTION_PRIVATE_JWK;
  const providerSigningPrivateJwk = env.PROVIDER_SIGNING_PRIVATE_JWK;

  const canSealPromotion =
    typeof providerEncryptionPrivateJwk === "string" &&
    typeof providerSigningPrivateJwk === "string";

  const promotedPayload = canSealPromotion
    ? await createPromotedEnvelope({
        content,
        accountId: branch.writerAccountId ?? branch.ownerAccountId ?? accountId,
        metadata: promotedMetadata,
        providerEncryptionPrivateJwk,
        providerSigningPrivateJwk,
      })
    : {
        content,
        metadata: promotedMetadata,
      };

  const promotedId = await createRemoteJsonDrop(env.R2_BUCKET, promotedPayload, env.DB);

  return new Response(
    JSON.stringify({
      dropId: promotedId,
      url: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/d/${toShortDropId(promotedId)}`,
      rootDropId,
      branchId,
      snapshotId: branch.headSnapshotId,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
};

import type { R2Bucket } from "@cloudflare/workers-types";
import { toShortDropId } from "../../../shared/drop/id";
import {
  resolveAuthenticatedAccountId,
  type AccountAuthEnv,
} from "./accountAuth";
import { readBranchContent } from "./branchContent";
import { readBranch } from "./branchRepository";
import { sanitizeDiffAuthToken } from "./diffAuth";
import { resolveRemoteDropId } from "./dropId";
import { resolveParam } from "./http";
import { createPromotedEnvelope } from "./promotedEnvelope";
import { createRemoteJsonDrop } from "./remoteDropCreate";

/** Environment required to promote a branch snapshot into a new drop. */
export interface BranchPromotionEnv extends AccountAuthEnv {
  R2_BUCKET: R2Bucket;
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

  const branch = await readBranch(env.R2_BUCKET, rootDropId, branchId);
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

  const promotedId = await createRemoteJsonDrop(env.R2_BUCKET, promotedPayload);

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

import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import {
  resolveAuthenticatedAccountId,
  type AccountAuthEnv,
} from "../../../_lib/accountAuth";
import { readBranch, readBranchContent } from "../../../_lib/branchState";
import { createPromotedEnvelope } from "../../../_lib/promotedEnvelope";
import { createRemoteJsonDrop } from "../../../_lib/remoteDropCreate";
import { sanitizeDiffAuthToken } from "../../../_lib/diffAuth";
import { resolveRemoteDropId } from "../../../_lib/dropId";
import { toShortDropId } from "../../../../../shared/drop/id";

interface Env extends AccountAuthEnv {
  R2_BUCKET: R2Bucket;
  PUBLIC_BASE_URL: string;
  PROVIDER_ENCRYPTION_PRIVATE_JWK?: string;
  PROVIDER_SIGNING_PRIVATE_JWK?: string;
}

const resolveParam = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : Array.isArray(value) ? value[0] : "";

export const onRequestPost: PagesFunction<Env, "rootId" | "branchId"> = async ({
  env,
  params,
  request,
}) => {
  if (!env.R2_BUCKET) {
    return new Response("R2 bucket binding is required.", { status: 500 });
  }
  if (!env.PUBLIC_BASE_URL) {
    return new Response("PUBLIC_BASE_URL environment variable is required.", {
      status: 500,
    });
  }

  const rootDropId = await resolveRemoteDropId(env.R2_BUCKET, resolveParam(params.rootId));
  const branchId = sanitizeDiffAuthToken(resolveParam(params.branchId));
  const accountId = await resolveAuthenticatedAccountId(request, env);
  if (!rootDropId || !branchId) {
    return new Response("Root drop ID and branch ID are required.", { status: 400 });
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
    return new Response("You are not allowed to promote this branch.", { status: 403 });
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

export const onRequest: PagesFunction<Env, "rootId" | "branchId"> = async (context) => {
  if (context.request.method === "POST") {
    return onRequestPost(context);
  }

  return new Response("Method Not Allowed", { status: 405 });
};

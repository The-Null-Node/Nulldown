import { resolveAuthenticatedAccountId } from "../../accounts/session/authentication";
import { sanitizeDiffAuthToken } from "../../diffs/credentials/repository";
import { createDropIdentityRepository } from "../../drops/identity/id";
import { resolveParam } from "../../core/http/responses";
import {
  canReadRoot,
  resolveRootReadAuthorization,
} from "../../security/readAuthorization";
import { resolveBranchForActor } from "../lifecycle";
import type { BranchRootParams, BranchRouteEnv } from "./request-context";

/** Resolves or creates the branch assigned to the authenticated account/client. */
export const resolveBranchForRequest = async (
  env: BranchRouteEnv,
  params: BranchRootParams,
  request: Request,
): Promise<Response> => {
  if (!env.R2_BUCKET) {
    return new Response("R2 bucket binding is required.", { status: 500 });
  }

  const accountId = await resolveAuthenticatedAccountId(request, env);
  if (!accountId) {
    return new Response("Authenticated account session is required.", {
      status: 401,
    });
  }

  const dropIdentityRepository = createDropIdentityRepository({
    blobs: env.R2_BUCKET,
    sql: env.DB,
  });
  const id = await dropIdentityRepository.resolveRemoteDropIdForReadRequest(
    resolveParam(params.id),
  );
  if (!id) {
    return new Response("Drop ID is required.", { status: 400 });
  }

  const authorization = await resolveRootReadAuthorization(request, env, id);
  if (!canReadRoot(authorization)) {
    return new Response("Branch not found.", { status: 404 });
  }

  const clientId = sanitizeDiffAuthToken(
    request.headers.get("x-nulldown-client-id") ||
      new URL(request.url).searchParams.get("clientId"),
  );

  try {
    const { branch, created } = await resolveBranchForActor(
      env.R2_BUCKET,
      id,
      accountId,
      clientId,
      env.PROVIDER_ENCRYPTION_PRIVATE_JWK,
      env.DB,
    );

    return new Response(
      JSON.stringify({
        rootDropId: id,
        branchId: branch.branchId,
        mode: branch.mode,
        created,
        headSnapshotId: branch.headSnapshotId,
        ownerAccountId: branch.ownerAccountId,
        writerAccountId: branch.writerAccountId,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Failed to resolve branch: ${message}`, {
      status: 400,
    });
  }
};

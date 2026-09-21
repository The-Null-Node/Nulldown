import { resolveAuthenticatedAccountId } from "../../accounts/session/authentication";
import { createBranchRepository } from "../../branches/storage/repository";
import { sanitizeDiffAuthToken } from "../../diffs/credentials/repository";
import { createDropIdentityRepository } from "../../drops/identity/id";
import { jsonErrorResponse, resolveParam } from "../../core/http/responses";
import {
  canReadBranch,
  canReadSensitiveBranch,
  resolveRootReadAuthorization,
} from "../../security/readAuthorization";
import type {
  ResolvedBranchTarget,
  ResolvedHeapEnv,
  ResolvedHeapParams,
} from "./types";

/** Result returned when resolving route params to a concrete branch target. */
export type ResolvedBranchTargetResult =
  | ResolvedBranchTarget
  | { error: Response };

const branchNotFoundResponse = (): Response =>
  jsonErrorResponse(404, "branch_not_found", "Branch not found.");

const resolveResolvedBranchIdentity = async (
  env: ResolvedHeapEnv,
  params: ResolvedHeapParams,
): Promise<
  | { rootDropId: string; branchId: string }
  | { error: Response }
> => {
  if (!env.R2_BUCKET) {
    return {
      error: new Response("R2 bucket binding is required.", { status: 500 }),
    };
  }

  const dropIdentityRepository = createDropIdentityRepository({
    blobs: env.R2_BUCKET,
    sql: env.DB,
  });
  const rootDropId = await dropIdentityRepository.resolveRemoteDropId(
    resolveParam(params.rootId),
  );
  const branchId = sanitizeDiffAuthToken(resolveParam(params.branchId));
  if (!rootDropId || !branchId) {
    return {
      error: jsonErrorResponse(
        400,
        "validation_failed",
        "Root drop ID and branch ID are required.",
      ),
    };
  }

  return { rootDropId, branchId };
};

const resolveReadableResolvedBranchIdentity = async (
  env: ResolvedHeapEnv,
  params: ResolvedHeapParams,
): Promise<
  | { rootDropId: string; branchId: string }
  | { error: Response }
> => {
  if (!env.R2_BUCKET) {
    return {
      error: new Response("R2 bucket binding is required.", { status: 500 }),
    };
  }

  const dropIdentityRepository = createDropIdentityRepository({
    blobs: env.R2_BUCKET,
    sql: env.DB,
  });
  const rootDropId =
    await dropIdentityRepository.resolveRemoteDropIdForReadRequest(
      resolveParam(params.rootId),
    );
  const branchId = sanitizeDiffAuthToken(resolveParam(params.branchId));
  if (!rootDropId || !branchId) {
    return {
      error: jsonErrorResponse(
        400,
        "validation_failed",
        "Root drop ID and branch ID are required.",
      ),
    };
  }

  return { rootDropId, branchId };
};

/** Resolves and validates the root drop and branch for resolved heap handlers. */
export const resolveResolvedBranchTarget = async (
  env: ResolvedHeapEnv,
  params: ResolvedHeapParams,
): Promise<ResolvedBranchTargetResult> => {
  const identity = await resolveResolvedBranchIdentity(env, params);
  if ("error" in identity) return identity;
  const { rootDropId, branchId } = identity;

  const branchRepository = createBranchRepository({
    blobs: env.R2_BUCKET,
    sql: env.DB,
  });
  const branch = await branchRepository.readBranch(rootDropId, branchId);
  if (!branch) {
    return {
      error: jsonErrorResponse(404, "branch_not_found", "Branch not found."),
    };
  }

  return { rootDropId, branchId, branch };
};

/** Resolves a readable branch after authorizing its trusted canonical root. */
export const resolveReadableResolvedBranchTarget = async (
  request: Request,
  env: ResolvedHeapEnv,
  params: ResolvedHeapParams,
): Promise<ResolvedBranchTargetResult> => {
  const identity = await resolveReadableResolvedBranchIdentity(env, params);
  if ("error" in identity) return identity;
  const { rootDropId, branchId } = identity;

  const authorization = await resolveRootReadAuthorization(
    request,
    env,
    rootDropId,
  );
  if (authorization.kind === "denied") {
    return { error: branchNotFoundResponse() };
  }

  const branch = await createBranchRepository({
    blobs: env.R2_BUCKET,
    sql: env.DB,
  }).readBranch(rootDropId, branchId);
  if (!branch || !canReadBranch(authorization, branch)) {
    return { error: branchNotFoundResponse() };
  }

  return { rootDropId, branchId, branch };
};

/** Checks that the authenticated account may read sensitive priority overlays. */
export const authorizeResolvedPriorityFactRead = async (
  request: Request,
  env: ResolvedHeapEnv,
  rootDropId: string,
  branch: { writerAccountId?: string | null },
): Promise<Response | null> => {
  if (await canReadSensitiveBranch(request, env, rootDropId, branch)) {
    return null;
  }

  return jsonErrorResponse(
    403,
    "forbidden",
    "Authenticated branch capability is required.",
  );
};

/** Checks that the authenticated account can mutate priority facts for a branch. */
export const authorizeResolvedPriorityFactWrite = async (
  request: Request,
  env: ResolvedHeapEnv,
  rootDropId: string,
  branch: { writerAccountId?: string | null },
  action: "create" | "delete",
): Promise<Response | null> => {
  const accountId = await resolveAuthenticatedAccountId(request, env);
  if (!accountId) {
    return jsonErrorResponse(
      401,
      "account_required",
      "Authenticated account session is required.",
    );
  }

  if (!(await canReadSensitiveBranch(request, env, rootDropId, branch))) {
    return jsonErrorResponse(
      403,
      "forbidden",
      `You are not allowed to ${action} priority facts for this branch.`,
    );
  }

  return null;
};

import {
  resolveAuthenticatedAccountId,
  type AccountAuthEnv,
} from "../accounts/session/auth";
import { createBranchRepository } from "../branches/storage/repository";
import { jsonErrorResponse, resolveParam } from "../core/http/responses";
import { createDropIdentityRepository } from "../drops/identity/id";
import {
  canReadBranch,
  canReadSensitiveBranch,
  resolveRootReadAuthorization,
} from "../security/readAuthorization";
import type {
  BlobObjectStore,
  SqlMetadataStore,
} from "../../../../src/server/ports";

/** Storage and authentication dependencies used for NullMem authorization. */
export interface NullMemAuthorizationEnv extends AccountAuthEnv {
  R2_BUCKET: BlobObjectStore;
  DB?: SqlMetadataStore;
}

/** Route target accepted by NullMem authorization checks. */
export interface NullMemTargetParams {
  rootId: string | string[];
  branchId: string | string[];
}

/** Canonical branch target returned after write-target resolution. */
export interface ResolvedNullMemTarget {
  rootDropId: string;
  branchId: string;
  branch: { ownerAccountId?: string | null; writerAccountId?: string | null };
}

/** Canonical branch target returned after read authorization. */
export interface ResolvedNullMemQueryTarget extends ResolvedNullMemTarget {
  canReadSensitive: boolean;
}

/** Access context returned after account-level authorization. */
export interface NullMemAccess {
  isAnonymous: boolean;
}

const branchNotFoundResponse = (): Response =>
  jsonErrorResponse(404, "branch_not_found", "Branch not found.");

/** Resolves an existing branch target before a NullMem write authorization check. */
export const resolveNullMemTarget = async (
  env: NullMemAuthorizationEnv,
  params: NullMemTargetParams,
): Promise<ResolvedNullMemTarget | { error: Response }> => {
  const requestedRootId = resolveParam(params.rootId);
  const requestedBranchId = resolveParam(params.branchId);
  if (!requestedRootId || !requestedBranchId) {
    return {
      error: jsonErrorResponse(
        400,
        "validation_failed",
        "rootId and branchId are required.",
      ),
    };
  }

  const dropIdentityRepository = createDropIdentityRepository({
    blobs: env.R2_BUCKET,
    sql: env.DB,
  });
  const rootDropId =
    await dropIdentityRepository.resolveRemoteDropId(requestedRootId);
  if (!rootDropId) {
    return {
      error: jsonErrorResponse(
        404,
        "root_drop_not_found",
        "Root drop not found.",
      ),
    };
  }

  const branchRepository = createBranchRepository({
    blobs: env.R2_BUCKET,
    sql: env.DB,
  });
  const branch = await branchRepository.readBranch(
    rootDropId,
    requestedBranchId,
  );
  if (!branch) {
    return {
      error: jsonErrorResponse(404, "branch_not_found", "Branch not found."),
    };
  }

  return { rootDropId, branchId: requestedBranchId, branch };
};

/** Resolves a readable branch and whether the caller may read sensitive memory. */
export const resolveNullMemQueryTarget = async (
  request: Request,
  env: NullMemAuthorizationEnv,
  params: NullMemTargetParams,
): Promise<ResolvedNullMemQueryTarget | { error: Response }> => {
  const requestedRootId = resolveParam(params.rootId);
  const requestedBranchId = resolveParam(params.branchId);
  if (!requestedRootId || !requestedBranchId) {
    return {
      error: jsonErrorResponse(
        400,
        "validation_failed",
        "rootId and branchId are required.",
      ),
    };
  }

  const dropIdentityRepository = createDropIdentityRepository({
    blobs: env.R2_BUCKET,
    sql: env.DB,
  });
  const rootDropId =
    await dropIdentityRepository.resolveRemoteDropIdForReadRequest(
      requestedRootId,
    );
  if (!rootDropId) {
    return {
      error: jsonErrorResponse(
        404,
        "root_drop_not_found",
        "Root drop not found.",
      ),
    };
  }

  const rootDecision = await resolveRootReadAuthorization(
    request,
    env,
    rootDropId,
  );
  if (rootDecision.kind === "denied") {
    return { error: branchNotFoundResponse() };
  }

  const branchRepository = createBranchRepository({
    blobs: env.R2_BUCKET,
    sql: env.DB,
  });
  const branch = await branchRepository.readBranch(
    rootDropId,
    requestedBranchId,
  );
  if (!branch || !canReadBranch(rootDecision, branch)) {
    return { error: branchNotFoundResponse() };
  }

  return {
    rootDropId,
    branchId: requestedBranchId,
    branch,
    canReadSensitive: await canReadSensitiveBranch(
      request,
      env,
      rootDropId,
      branch,
    ),
  };
};

/** Authorizes account access to a branch memory operation. */
export const authorizeNullMemAccess = async (
  request: Request,
  env: NullMemAuthorizationEnv,
  branch: { ownerAccountId?: string | null; writerAccountId?: string | null },
  action: "query" | "create" | "delete",
): Promise<NullMemAccess | Response> => {
  const accountId = await resolveAuthenticatedAccountId(request, env);
  if (!accountId) {
    if (action === "query") {
      return { isAnonymous: true };
    }
    return jsonErrorResponse(
      401,
      "account_required",
      "Authenticated account session is required.",
    );
  }

  if (
    accountId !== branch.ownerAccountId &&
    accountId !== branch.writerAccountId
  ) {
    return jsonErrorResponse(
      403,
      "forbidden",
      `You are not allowed to ${action} memory for this branch.`,
    );
  }

  return { isAnonymous: false };
};

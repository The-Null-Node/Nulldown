import {
  resolveAuthenticatedAccountId,
  type AccountAuthEnv,
} from "../accounts/session/authentication";
import { createBranchStatePlane } from "../../../../src/server/state-plane/gateway";
import type { LocalBranchApplicationSelection } from "../../../../src/server/state-plane/commit-application";
import { BranchStateError } from "../../../../shared/drop/branch-state";
import { branchStateErrorResponse } from "../branches/http/state-plane-errors";
import { jsonErrorResponse, resolveParam } from "../core/http/responses";
import { createDropIdentityRepository } from "../drops/identity/id";
import {
  canReadBranch,
  canReadSensitiveBranch,
  resolveRootReadAuthorization,
} from "../security/read-authorization";
import type {
  BlobObjectStore,
  SqlMetadataStore,
} from "../../../../src/server/ports";

/** Storage and authentication dependencies used for NullMem authorization. */
export interface NullMemAuthorizationEnv extends AccountAuthEnv {
  /** Request-owned local authority; an omitted memory capability rejects before legacy access. */
  localBranchApplication?: LocalBranchApplicationSelection;
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
  request: Request,
): Promise<ResolvedNullMemTarget | { error: Response }> => {
  if (env.localBranchApplication) {
    if (!(await resolveAuthenticatedAccountId(request, env))) {
      return {
        error: jsonErrorResponse(
          401,
          "account_required",
          "Authenticated account session is required.",
        ),
      };
    }
    if (!env.localBranchApplication.nullmem)
      return {
        error: branchStateErrorResponse(
          new BranchStateError("capability_unsupported"),
        ),
      };
  }
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
  const rootDropId = env.localBranchApplication
    ? await dropIdentityRepository.resolveRemoteDropIdForReadRequest(
        requestedRootId,
      )
    : await dropIdentityRepository.resolveRemoteDropId(requestedRootId);
  if (!rootDropId) {
    return {
      error: jsonErrorResponse(
        404,
        "root_drop_not_found",
        "Root drop not found.",
      ),
    };
  }

  const rootDecision = env.localBranchApplication
    ? await resolveRootReadAuthorization(request, env, rootDropId)
    : null;
  if (rootDecision?.kind === "denied")
    return { error: branchNotFoundResponse() };
  const statePlane = createBranchStatePlane({
    blobs: env.R2_BUCKET,
    sql: env.DB,
    localBranchApplication: env.localBranchApplication,
  });
  const branch = await statePlane.branches.readBranch(
    rootDropId,
    requestedBranchId,
  );
  if (!branch || (rootDecision && !canReadBranch(rootDecision, branch))) {
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
  if (env.localBranchApplication && !env.localBranchApplication.nullmem) {
    return {
      error: branchStateErrorResponse(
        new BranchStateError("capability_unsupported"),
      ),
    };
  }
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

  const statePlane = createBranchStatePlane({
    blobs: env.R2_BUCKET,
    sql: env.DB,
    localBranchApplication: env.localBranchApplication,
  });
  const branch = await statePlane.branches.readBranch(
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

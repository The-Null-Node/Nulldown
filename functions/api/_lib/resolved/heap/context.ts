import { resolveAuthenticatedAccountId } from "../../accounts/session/auth";
import { createBranchRepository } from "../../branches/storage/repository";
import { sanitizeDiffAuthToken } from "../../diffs/credentials/repository";
import { createDropIdentityRepository } from "../../drops/identity/id";
import { jsonErrorResponse, resolveParam } from "../../core/http/responses";
import type {
  ResolvedBranchTarget,
  ResolvedHeapEnv,
  ResolvedHeapParams,
} from "./types";

/** Result returned when resolving route params to a concrete branch target. */
export type ResolvedBranchTargetResult =
  | ResolvedBranchTarget
  | { error: Response };

/** Resolves and validates the root drop and branch for resolved heap handlers. */
export const resolveResolvedBranchTarget = async (
  env: ResolvedHeapEnv,
  params: ResolvedHeapParams,
): Promise<ResolvedBranchTargetResult> => {
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

/** Checks that the authenticated account can mutate priority facts for a branch. */
export const authorizeResolvedPriorityFactWrite = async (
  request: Request,
  env: ResolvedHeapEnv,
  branch: { ownerAccountId?: string | null; writerAccountId?: string | null },
  action: "create" | "list" | "delete",
): Promise<Response | null> => {
  const accountId = await resolveAuthenticatedAccountId(request, env);
  if (!accountId) {
    return jsonErrorResponse(
      401,
      "account_required",
      "Authenticated account session is required.",
    );
  }

  const canWrite =
    accountId === branch.ownerAccountId || accountId === branch.writerAccountId;
  if (!canWrite) {
    return jsonErrorResponse(
      403,
      "forbidden",
      `You are not allowed to ${action} priority facts for this branch.`,
    );
  }

  return null;
};

import type {
  BlobObjectStore,
  SqlMetadataStore,
} from "../../../../../src/server/ports";
import type { AccountAuthEnv } from "../../accounts/session/authentication";
import { sanitizeDiffAuthToken } from "../../diffs/credentials/repository";
import { createDropIdentityRepository } from "../../drops/identity/id";
import { resolveParam } from "../../core/http/responses";
import { createBranchRepository } from "../storage/repository";

/** Environment required by branch HTTP application services. */
export interface BranchRouteEnv extends AccountAuthEnv {
  R2_BUCKET: BlobObjectStore;
  DB?: SqlMetadataStore;
  PROVIDER_ENCRYPTION_PRIVATE_JWK?: string;
  BRANCH_HEAP_BACKFILL_TOKEN?: string;
}

/** Route params for root-only branch operations. */
export interface BranchRootParams {
  id: string | string[];
}

/** Route params for branch-specific operations. */
export interface BranchTargetParams {
  rootId: string | string[];
  branchId: string | string[];
}

/** Resolves a canonical root identifier from a root-only branch route. */
export const resolveRootDropIdForReadRequest = async (
  env: Pick<BranchRouteEnv, "R2_BUCKET" | "DB">,
  idParam: string | string[] | undefined,
): Promise<string | null> => {
  const dropIdentityRepository = createDropIdentityRepository({
    blobs: env.R2_BUCKET,
    sql: env.DB,
  });
  return dropIdentityRepository.resolveRemoteDropIdForReadRequest(
    resolveParam(idParam),
  );
};

/** Resolves and validates a canonical root/branch route target. */
export const resolveBranchTarget = async (
  env: Pick<BranchRouteEnv, "R2_BUCKET" | "DB">,
  params: BranchTargetParams,
): Promise<{ rootDropId: string; branchId: string } | { error: Response }> => {
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
      error: new Response("Root drop ID and branch ID are required.", {
        status: 400,
      }),
    };
  }

  return { rootDropId, branchId };
};

/** Creates the branch repository used for one HTTP request. */
export const createBranchRouteRepository = (env: BranchRouteEnv) =>
  createBranchRepository({ blobs: env.R2_BUCKET, sql: env.DB });

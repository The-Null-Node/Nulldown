import {
  canReadBranch,
  resolveRootReadAuthorization,
} from "../../security/read-authorization";
import { readBranchContent } from "../content/replay";
import {
  createBranchRouteRepository,
  resolveBranchTarget,
  type BranchRouteEnv,
  type BranchTargetParams,
} from "./request-context";

/** Returns materialized branch-head content visible to the caller. */
export const getBranchContent = async (
  env: BranchRouteEnv,
  params: BranchTargetParams,
  request: Request,
): Promise<Response> => {
  if (!env.R2_BUCKET) {
    return new Response("R2 bucket binding is required.", { status: 500 });
  }

  const target = await resolveBranchTarget(env, params);
  if ("error" in target) return target.error;
  const { rootDropId, branchId } = target;

  const authorization = await resolveRootReadAuthorization(
    request,
    env,
    rootDropId,
  );
  if (authorization.kind === "denied") {
    return new Response("Branch not found.", { status: 404 });
  }

  const branchRepository = createBranchRouteRepository(env);
  const branch = await branchRepository.readBranch(rootDropId, branchId);
  if (!branch || !canReadBranch(authorization, branch)) {
    return new Response("Branch not found.", { status: 404 });
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

  return new Response(
    JSON.stringify({
      rootDropId,
      branchId,
      snapshotId: branch.headSnapshotId,
      headEventSeq:
        typeof branch.headEventSeq === "number" ? branch.headEventSeq : null,
      content,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
};

/** Lists stored snapshots for a branch visible to the caller. */
export const listBranchSnapshots = async (
  env: BranchRouteEnv,
  params: BranchTargetParams,
  request: Request,
): Promise<Response> => {
  if (!env.R2_BUCKET) {
    return new Response("R2 bucket binding is required.", { status: 500 });
  }

  const target = await resolveBranchTarget(env, params);
  if ("error" in target) return target.error;
  const { rootDropId, branchId } = target;

  const authorization = await resolveRootReadAuthorization(
    request,
    env,
    rootDropId,
  );
  if (authorization.kind === "denied") {
    return new Response("Branch not found.", { status: 404 });
  }

  const branchRepository = createBranchRouteRepository(env);
  const branch = await branchRepository.readBranch(rootDropId, branchId);
  if (!branch || !canReadBranch(authorization, branch)) {
    return new Response("Branch not found.", { status: 404 });
  }

  const snapshots = await branchRepository.listSnapshotsForBranch(
    rootDropId,
    branchId,
  );
  return new Response(JSON.stringify({ rootDropId, branchId, snapshots }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

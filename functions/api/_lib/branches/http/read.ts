import {
  canReadBranch,
  resolveRootReadAuthorization,
} from "../../security/read-authorization";
import { unobserved, type Timing } from "../../core/observability/profiling";
import {
  createBranchRouteStatePlane,
  resolveBranchTarget,
  type BranchRouteEnv,
  type BranchTargetParams,
} from "./request-context";

/** Returns materialized branch-head content visible to the caller. */
export const getBranchContent = async (
  env: BranchRouteEnv,
  params: BranchTargetParams,
  request: Request,
  timing: Timing = unobserved,
): Promise<Response> => {
  if (!env.R2_BUCKET) {
    return new Response("R2 bucket binding is required.", { status: 500 });
  }

  const target = await timing.phase("content.target", () =>
    resolveBranchTarget(env, params),
  );
  if ("error" in target) return target.error;
  const { rootDropId, branchId } = target;

  const authorization = await timing.phase("content.authority", () =>
    resolveRootReadAuthorization(request, env, rootDropId),
  );
  if (authorization.kind === "denied") {
    return new Response("Branch not found.", { status: 404 });
  }

  const statePlane = createBranchRouteStatePlane(env);
  const branch = await timing.phase("content.branch", () =>
    statePlane.branches.readBranch(rootDropId, branchId),
  );
  if (!branch || !canReadBranch(authorization, branch)) {
    return new Response("Branch not found.", { status: 404 });
  }

  const content = await timing.phase("content.materialize", (child) =>
    createBranchRouteStatePlane(env, child).snapshots.readContent(
      rootDropId,
      branchId,
      branch.headSnapshotId,
    ),
  );
  if (content === null) {
    return new Response("Branch content not found.", { status: 404 });
  }

  return new Response(
    timing.sync("content.serialize", () =>
      JSON.stringify({
        rootDropId,
        branchId,
        snapshotId: branch.headSnapshotId,
        headEventSeq:
          typeof branch.headEventSeq === "number" ? branch.headEventSeq : null,
        content,
      }),
    ),
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

  const statePlane = createBranchRouteStatePlane(env);
  const branch = await statePlane.branches.readBranch(rootDropId, branchId);
  if (!branch || !canReadBranch(authorization, branch)) {
    return new Response("Branch not found.", { status: 404 });
  }

  const snapshots = await statePlane.snapshots.listSnapshotsForBranch(
    rootDropId,
    branchId,
  );
  return new Response(JSON.stringify({ rootDropId, branchId, snapshots }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

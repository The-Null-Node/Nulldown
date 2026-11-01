import {
  canReadBranch,
  resolveRootReadAuthorization,
} from "../../security/read-authorization";
import { unobserved, type Timing } from "../../core/observability/profiling";
import { BranchStateError } from "../../../../../shared/drop/branch-state";
import { branchStateErrorResponse } from "./state-plane-errors";
import {
  apiHttpErrorResponse,
  isApiHttpError,
} from "../../core/http/responses";
import {
  createBranchRouteStatePlane,
  resolveBranchTarget,
  type BranchRouteEnv,
  type BranchTargetParams,
} from "./request-context";

/** Returns a captured head or explicitly selected historical snapshot visible to the caller. */
export const getBranchContent = async (
  env: BranchRouteEnv,
  params: BranchTargetParams,
  request: Request,
  timing: Timing = unobserved,
): Promise<Response> => {
  try {
    return await readBranchContent(env, params, request, timing);
  } catch (error) {
    if (isApiHttpError(error)) return apiHttpErrorResponse(error);
    if (error instanceof BranchStateError)
      return branchStateErrorResponse(error);
    throw error;
  }
};

const readBranchContent = async (
  env: BranchRouteEnv,
  params: BranchTargetParams,
  request: Request,
  timing: Timing,
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

  const selectors = new URL(request.url).searchParams.getAll("snapshotId");
  if (
    selectors.length > 1 ||
    (selectors.length === 1 &&
      (!/^(0|[1-9]\d*)$/.test(selectors[0]) ||
        !Number.isSafeInteger(Number(selectors[0]))))
  ) {
    return new Response("Invalid snapshot ID.", { status: 400 });
  }
  const snapshotId = selectors.length
    ? Number(selectors[0])
    : branch.headSnapshotId;
  let eventSeq =
    typeof branch.headEventSeq === "number" ? branch.headEventSeq : null;
  if (selectors.length) {
    if (snapshotId > branch.headSnapshotId)
      return new Response("Branch snapshot not found.", { status: 404 });
    const snapshot = await timing.phase("content.snapshot", () =>
      statePlane.snapshots.readSnapshot(rootDropId, branchId, snapshotId),
    );
    if (!snapshot)
      return new Response("Branch snapshot not found.", { status: 404 });
    eventSeq = snapshotId === 0 ? -1 : (snapshot.patchEndSeq ?? null);
  }

  const content = await timing.phase("content.materialize", (child) =>
    (env.localBranchApplication
      ? statePlane
      : createBranchRouteStatePlane(env, child)
    ).snapshots.readContent(rootDropId, branchId, snapshotId),
  );
  if (content === null) {
    return new Response("Branch content not found.", { status: 404 });
  }

  return new Response(
    timing.sync("content.serialize", () =>
      JSON.stringify({
        rootDropId,
        branchId,
        snapshotId,
        headEventSeq: eventSeq,
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
  try {
    return await readBranchSnapshots(env, params, request);
  } catch (error) {
    if (isApiHttpError(error)) return apiHttpErrorResponse(error);
    if (error instanceof BranchStateError)
      return branchStateErrorResponse(error);
    throw error;
  }
};

const readBranchSnapshots = async (
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

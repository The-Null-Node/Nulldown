import { resolveRootReadAuthorization } from "../../security/read-authorization";
import {
  createBranchRouteRepository,
  resolveRootDropIdForReadRequest,
  type BranchRootParams,
  type BranchRouteEnv,
} from "./request-context";

/** Lists branches visible to the caller for one root drop. */
export const listBranchesForDrop = async (
  env: BranchRouteEnv,
  params: BranchRootParams,
  request: Request,
): Promise<Response> => {
  if (!env.R2_BUCKET) {
    return new Response("R2 bucket binding is required.", { status: 500 });
  }

  const id = await resolveRootDropIdForReadRequest(env, params.id);
  if (!id) {
    return new Response("Drop ID is required.", { status: 400 });
  }

  const authorization = await resolveRootReadAuthorization(request, env, id);
  if (authorization.kind === "denied") {
    return new Response("Branch not found.", { status: 404 });
  }

  const branchRepository = createBranchRouteRepository(env);
  let branches = await branchRepository.listBranchesForRoot(id);
  if (authorization.kind === "private" && !authorization.isCanonicalOwner) {
    branches = branches.filter(
      (branch) => branch.writerAccountId === authorization.accountId,
    );
    if (!branches.length) {
      return new Response("Branch not found.", { status: 404 });
    }
  }
  return new Response(JSON.stringify({ rootDropId: id, branches }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

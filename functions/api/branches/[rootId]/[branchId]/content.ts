import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import { readBranch, readBranchContent } from "../../../_lib/branchState";
import { sanitizeDiffAuthToken } from "../../../_lib/diffAuth";
import { resolveRemoteDropId } from "../../../_lib/dropId";

interface Env {
  R2_BUCKET: R2Bucket;
}

const resolveParam = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : Array.isArray(value) ? value[0] : "";

export const onRequestGet: PagesFunction<Env, "rootId" | "branchId"> = async ({
  env,
  params,
}) => {
  if (!env.R2_BUCKET) {
    return new Response("R2 bucket binding is required.", { status: 500 });
  }

  const rootDropId = await resolveRemoteDropId(env.R2_BUCKET, resolveParam(params.rootId));
  const branchId = sanitizeDiffAuthToken(resolveParam(params.branchId));
  if (!rootDropId || !branchId) {
    return new Response("Root drop ID and branch ID are required.", { status: 400 });
  }

  const branch = await readBranch(env.R2_BUCKET, rootDropId, branchId);
  if (!branch) {
    return new Response("Branch not found.", { status: 404 });
  }

  const content = await readBranchContent(
    env.R2_BUCKET,
    rootDropId,
    branchId,
    branch.headSnapshotId,
  );
  if (content === null) {
    return new Response("Branch content not found.", { status: 404 });
  }

  return new Response(
    JSON.stringify({
      rootDropId,
      branchId,
      snapshotId: branch.headSnapshotId,
      content,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
};

export const onRequest: PagesFunction<Env, "rootId" | "branchId"> = async (context) => {
  if (context.request.method === "GET") {
    return onRequestGet(context);
  }

  return new Response("Method Not Allowed", { status: 405 });
};

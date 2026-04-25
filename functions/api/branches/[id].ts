import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import { listBranchesForRoot } from "../_lib/branchState";
import { resolveRemoteDropId } from "../_lib/dropId";

interface Env {
  R2_BUCKET: R2Bucket;
}

const resolveId = (id: string | string[] | undefined) =>
  typeof id === "string" ? id : Array.isArray(id) ? id[0] : "";

export const onRequestGet: PagesFunction<Env, "id"> = async ({ env, params }) => {
  if (!env.R2_BUCKET) {
    return new Response("R2 bucket binding is required.", { status: 500 });
  }

  const id = await resolveRemoteDropId(env.R2_BUCKET, resolveId(params.id));
  if (!id) {
    return new Response("Drop ID is required.", { status: 400 });
  }

  const branches = await listBranchesForRoot(env.R2_BUCKET, id);
  return new Response(JSON.stringify({ rootDropId: id, branches }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const onRequest: PagesFunction<Env, "id"> = async (context) => {
  if (context.request.method === "GET") {
    return onRequestGet(context);
  }

  return new Response("Method Not Allowed", { status: 405 });
};

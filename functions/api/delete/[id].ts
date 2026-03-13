import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import { resolveRemoteDropId } from "../_lib/dropId";

interface Env {
  R2_BUCKET: R2Bucket;
}

const resolveId = (id: string | string[] | undefined) =>
  typeof id === "string" ? id : Array.isArray(id) ? id[0] : "";

export const onRequestDelete: PagesFunction<Env, "id"> = async ({ env, params }) => {
  try {
    if (!env.R2_BUCKET) {
      return new Response("R2 bucket binding is required.", { status: 500 });
    }

    const requestedId = resolveId(params.id);
    const id = await resolveRemoteDropId(env.R2_BUCKET, requestedId);

    if (!id) {
      return new Response("Drop ID is required.", { status: 400 });
    }

    await env.R2_BUCKET.delete(id);

    return new Response(null, { status: 204 });
  } catch (error: unknown) {
    console.error("Error deleting drop:", error);
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Failed to delete drop: ${message}`, { status: 500 });
  }
};

export const onRequest: PagesFunction<Env, "id"> = async (context) => {
  if (context.request.method === "DELETE") {
    return onRequestDelete(context);
  }

  return new Response("Method Not Allowed", { status: 405 });
};

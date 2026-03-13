import { R2Bucket } from "@cloudflare/workers-types";
import { resolveRemoteDropId } from "../_lib/dropId";

// Define the expected shape of the environment variables
interface Env {
  R2_BUCKET: R2Bucket; // R2 Bucket Binding (set in Cloudflare Pages dashboard)
}

// Basic validation for required environment variables
function validateEnv(env: Env): void {
  if (!env.R2_BUCKET)
    throw new Error(
      "R2_BUCKET binding is required. Configure in Cloudflare Pages > Settings > Functions > R2 bucket bindings",
    );
}

export const onRequestGet: PagesFunction<Env, "id"> = async ({
  env,
  params,
}) => {
  const copyHeaders = (headers: Headers, object: R2Object) => {
    Object.entries(object.httpMetadata || {}).forEach(([key, value]) => {
      headers.set(key, value as string);
    });
  };

  try {
    validateEnv(env);
    const requestedId =
      typeof params.id === "string" ? params.id : params.id?.[0] ?? "";

    const id = await resolveRemoteDropId(env.R2_BUCKET, requestedId);

    if (!id) return new Response("Drop ID is required.", { status: 400 });

    const object = await env.R2_BUCKET.get(id);

    if (object === null)
      return new Response("Drop not found.", { status: 404 });

    const headers = new Headers({
      "Content-Type": object.httpMetadata?.contentType || "text/plain",
      ETag: object.httpEtag,
      "X-Drop-Canonical-Id": id,
    });

    copyHeaders(headers, object);

    return new Response(object.body, {
      status: 200,
      headers: headers,
    });
  } catch (error: unknown) {
    console.error("Error retrieving drop:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return new Response(`Failed to retrieve drop: ${errorMessage}`, {
      status: 500,
    });
  }
};

// Fallback for other methods or if only onRequestGet is defined for this route file
export const onRequest: PagesFunction<Env, "id"> = async (context) => {
  if (context.request.method === "GET") {
    return onRequestGet(context);
  }
  return new Response("Method Not Allowed", { status: 405 });
};

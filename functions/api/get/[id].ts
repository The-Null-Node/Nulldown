import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3"; // Keep for reference if R2_BUCKET.get() fails

// Define the expected shape of the environment variables
interface Env {
  R2_BUCKET: R2Bucket;
  R2_BUCKET_NAME: string; // Still useful for logging or direct S3 SDK use
  R2_ACCOUNT_ID: string; // For direct S3 SDK use
  R2_ACCESS_KEY_ID: string; // For direct S3 SDK use
  R2_SECRET_ACCESS_KEY: string; // For direct S3 SDK use
  // PUBLIC_BASE_URL is not strictly needed for GET but good to have defined if other parts of Env expect it
}

// Basic validation (optional for GET, but good for consistency)
function validateEnv(env: Env): void {
  if (!env.R2_BUCKET) throw new Error("R2_BUCKET binding is required");
  if (!env.R2_BUCKET_NAME) throw new Error("R2_BUCKET_NAME environment variable is required");
  // S3 client specific vars are not strictly needed if only using R2_BUCKET.get()
}

export const onRequestGet: PagesFunction<Env, 'id'> = async ({ request, env, params }) => {
  const copyHeaders = (headers: Headers, object: R2Object) => {
    Object.entries(object.httpMetadata || {}).forEach(([key, value]) => {
      headers.set(key, value as string);
    });
  }

  try {
    validateEnv(env);
    const id = typeof params.id === 'string' ? params.id : params.id[0]; // Handle if params.id is string[]

    if (!id)
      return new Response("Drop ID is required.", { status: 400 });

    const object = await env.R2_BUCKET.get(id);

    if (object === null) 
      return new Response("Drop not found.", { status: 404 });

    const headers = new Headers({
      'Content-Type': object.httpMetadata?.contentType || 'text/plain',
      'ETag': object.httpEtag,
    });


    copyHeaders(headers, object);

    return new Response(object.body, {
      status: 200,
      headers: headers
    });
  } catch (error: unknown) {
    console.error("Error retrieving drop:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return new Response(`Failed to retrieve drop: ${errorMessage}`, { status: 500 });
  }
};

// Fallback for other methods or if only onRequestGet is defined for this route file
export const onRequest: PagesFunction<Env, 'id'> = async (context) => {
  if (context.request.method === 'GET') {
    return onRequestGet(context);
  }
  return new Response('Method Not Allowed', { status: 405 });
}; 
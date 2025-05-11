import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { nanoid } from "nanoid";

// Define the expected shape of the environment variables
// Includes bindings (like R2_BUCKET) and regular variables
interface Env {
  R2_BUCKET: R2Bucket; // This comes from the R2 Bucket Binding
  R2_BUCKET_NAME: string;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  PUBLIC_BASE_URL: string;
}

// Basic validation for environment variables
function validateEnv(env: Env): void {
  if (!env.R2_BUCKET) throw new Error("R2_BUCKET binding is required");
  if (!env.R2_BUCKET_NAME) throw new Error("R2_BUCKET_NAME environment variable is required");
  if (!env.R2_ACCOUNT_ID) throw new Error("R2_ACCOUNT_ID environment variable is required");
  if (!env.R2_ACCESS_KEY_ID) throw new Error("R2_ACCESS_KEY_ID environment variable is required");
  if (!env.R2_SECRET_ACCESS_KEY) throw new Error("R2_SECRET_ACCESS_KEY environment variable is required");
  if (!env.PUBLIC_BASE_URL) throw new Error("PUBLIC_BASE_URL environment variable is required");
}

// Initialize S3 client for R2
function getS3Client(env: Env): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
}

// Define the onRequestPost function signature using Cloudflare Pages types
// EventContext includes request, env, params, waitUntil, next, data
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  try {
    validateEnv(env);

    const textContent = await request.text();
    if (!textContent) {
      return new Response("Request body cannot be empty.", { status: 400 });
    }

    const id = nanoid(6); // Generate a 6-character unique ID
    // const bucketName = env.R2_BUCKET_NAME; // Not used if using R2_BUCKET.put directly
    // const s3Client = getS3Client(env); // Not used if using R2_BUCKET.put directly

    // Use the R2Bucket binding provided by Cloudflare Pages
    await env.R2_BUCKET.put(id, textContent, {
      httpMetadata: { contentType: 'text/plain' },
    });

    /* // Alternative using S3 client (requires explicit credentials)
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: id,
      Body: textContent,
      ContentType: "text/plain",
    });
    await s3Client.send(command);
    */

    // Construct the URL for the created drop
    const baseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, '');
    const dropUrl = `${baseUrl}/d/${id}`; // Assuming the path /d/:id is used for viewing drops

    console.log(`Stored drop with ID: ${id}`);

    return new Response(JSON.stringify({ id: id, url: dropUrl }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (error: unknown) {
    console.error("Error storing drop:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return new Response(`Failed to store drop: ${errorMessage}`, { status: 500 });
  }
};

// Handle other methods (optional, returns 405 Method Not Allowed)
export const onRequest: PagesFunction<Env> = async ({ request }) => {
   if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  // Fallback or further routing if needed, otherwise this won't be hit due to onRequestPost
  return new Response('Endpoint requires POST method', { status: 405 });
}; 
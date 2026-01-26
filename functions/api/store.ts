import { nanoid } from "nanoid";
import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";

// Define the expected shape of the environment variables
interface Env {
  R2_BUCKET: R2Bucket;
  PUBLIC_BASE_URL: string;
}

// Basic validation for required environment variables
function validateEnv(env: Env): void {
  if (!env.R2_BUCKET)
    throw new Error(
      "R2_BUCKET binding is required. Configure in Cloudflare Pages > Settings > Functions > R2 bucket bindings",
    );
  if (!env.PUBLIC_BASE_URL)
    throw new Error(
      "PUBLIC_BASE_URL environment variable is required. Set in Cloudflare Pages > Settings > Environment variables",
    );
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

    // Use the R2Bucket binding provided by Cloudflare Pages
    await env.R2_BUCKET.put(id, textContent, {
      httpMetadata: { contentType: "text/plain" },
    });

    // Construct the URL for the created drop
    const baseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, "");
    const dropUrl = `${baseUrl}/d/${id}`; // Assuming the path /d/:id is used for viewing drops

    console.log(`Stored drop with ID: ${id}`);

    return new Response(JSON.stringify({ id: id, url: dropUrl }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Error storing drop:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return new Response(`Failed to store drop: ${errorMessage}`, {
      status: 500,
    });
  }
};

// Handle other methods (optional, returns 405 Method Not Allowed)
export const onRequest: PagesFunction<Env> = async ({ request }) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  // Fallback or further routing if needed, otherwise this won't be hit due to onRequestPost
  return new Response("Endpoint requires POST method", { status: 405 });
};

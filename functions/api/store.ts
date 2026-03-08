import { nanoid } from "nanoid";
import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import {
  isDropEnvelopeV1,
  isDropPayload,
  serializeDropEnvelopeForProviderSignature,
  type DropEnvelopeV1,
} from "../../shared/drop/types";

// Define the expected shape of the environment variables
interface Env {
  R2_BUCKET: R2Bucket;
  PUBLIC_BASE_URL: string;
  PROVIDER_SIGNING_PRIVATE_JWK?: string;
}

const textEncoder = new TextEncoder();

const toBase64 = (value: ArrayBuffer): string => {
  const bytes = new Uint8Array(value);
  let binary = "";

  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary);
};

const signProviderEnvelope = async (
  envelope: DropEnvelopeV1,
  env: Env,
): Promise<DropEnvelopeV1> => {
  const rawProviderKey = env.PROVIDER_SIGNING_PRIVATE_JWK;
  if (!rawProviderKey) {
    return envelope;
  }

  let jwk: JsonWebKey;

  try {
    jwk = JSON.parse(rawProviderKey) as JsonWebKey;
  } catch (error) {
    console.error("Invalid PROVIDER_SIGNING_PRIVATE_JWK:", error);
    return envelope;
  }

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    false,
    ["sign"],
  );

  const signedPayload = serializeDropEnvelopeForProviderSignature(envelope);
  const signature = await crypto.subtle.sign(
    {
      name: "ECDSA",
      hash: "SHA-256",
    },
    key,
    textEncoder.encode(signedPayload),
  );

  const keyIdSource = jwk as unknown as Record<string, unknown>;
  const keyId = typeof keyIdSource.kid === "string" ? keyIdSource.kid : "provider";

  return {
    ...envelope,
    signatures: {
      ...envelope.signatures,
      provider: {
        kid: keyId,
        alg: "ECDSA_P256_SHA256",
        sig: toBase64(signature),
      },
    },
  };
};

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

    const contentType = request.headers.get("Content-Type") || "";
    const isJson = contentType.includes("application/json");
    const rawBody = await request.text();
    let storedPayload = rawBody;
    let storedContentType = isJson ? "application/json" : "text/plain";

    if (isJson) {
      let parsed: unknown;

      try {
        parsed = JSON.parse(rawBody);
      } catch (error) {
        return new Response("Invalid JSON payload.", { status: 400 });
      }

      if (isDropEnvelopeV1(parsed)) {
        const signedEnvelope = await signProviderEnvelope(parsed, env);
        storedPayload = JSON.stringify(signedEnvelope);
      } else if (isDropPayload(parsed)) {
        if (!parsed.content.trim()) {
          return new Response("Request body cannot be empty.", { status: 400 });
        }

        storedPayload = JSON.stringify({
          content: parsed.content,
          metadata: parsed.metadata || {},
        });
      } else {
        return new Response(
          "Unsupported JSON payload. Expected a drop payload or encrypted drop envelope.",
          { status: 400 },
        );
      }
    } else if (!rawBody.trim()) {
      return new Response("Request body cannot be empty.", { status: 400 });
    }

    const id = nanoid(6); // Generate a 6-character unique ID

    await env.R2_BUCKET.put(id, storedPayload, {
      httpMetadata: { contentType: storedContentType },
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

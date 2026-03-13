import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import {
  DROP_ID_LENGTH,
  generateDropId,
  isDropIdToken,
  toShortDropId,
} from "../../shared/drop/id";
import {
  isDropEnvelopeV1,
  isDropPayload,
  serializeDropEnvelopeForProviderSignature,
  type DropEnvelopeV1,
} from "../../shared/drop/types";
import {
  removeRemoteAliasIfMatch,
  reserveRemoteAlias,
} from "./_lib/dropId";

interface Env {
  R2_BUCKET: R2Bucket;
  PUBLIC_BASE_URL: string;
  PROVIDER_SIGNING_PRIVATE_JWK?: string;
}

interface StoreRequestBody {
  id?: string;
  upsert?: boolean;
  envelope?: unknown;
}

const textEncoder = new TextEncoder();
const MAX_ID_ALLOCATION_ATTEMPTS = 64;

const toBase64 = (value: ArrayBuffer): string => {
  const bytes = new Uint8Array(value);
  let binary = "";

  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary);
};

const sanitizeDropId = (value: string | undefined): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!isDropIdToken(trimmed)) {
    return null;
  }

  if (trimmed.length < DROP_ID_LENGTH || trimmed.length > 120) {
    return null;
  }

  return trimmed;
};

const putDropObject = async (
  bucket: R2Bucket,
  id: string,
  payload: string,
  contentType: string,
  upsert: boolean,
): Promise<boolean> => {
  if (upsert) {
    await bucket.put(id, payload, {
      httpMetadata: { contentType },
    });
    return true;
  }

  const created = await bucket.put(id, payload, {
    onlyIf: {
      etagDoesNotMatch: "*",
    },
    httpMetadata: { contentType },
  });

  return Boolean(created);
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

const parseStoreRequest = (parsed: unknown) => {
  if (typeof parsed !== "object" || parsed === null) {
    return { id: null as string | null, upsert: false, payload: parsed };
  }

  const body = parsed as StoreRequestBody;
  if (body.envelope !== undefined) {
    return {
      id: sanitizeDropId(body.id),
      upsert: Boolean(body.upsert),
      payload: body.envelope,
    };
  }

  return {
    id: sanitizeDropId(body.id),
    upsert: Boolean(body.upsert),
    payload: parsed,
  };
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  try {
    validateEnv(env);

    const contentType = request.headers.get("Content-Type") || "";
    const isJson = contentType.includes("application/json");
    const rawBody = await request.text();
    let storedPayload = rawBody;
    let storedContentType = isJson ? "application/json" : "text/plain";
    let requestedId: string | null = null;
    let upsert = false;

    if (isJson) {
      let parsed: unknown;

      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return new Response("Invalid JSON payload.", { status: 400 });
      }

      const parsedRequest = parseStoreRequest(parsed);
      requestedId = parsedRequest.id;
      upsert = parsedRequest.upsert;

      if (isDropEnvelopeV1(parsedRequest.payload)) {
        const signedEnvelope = await signProviderEnvelope(parsedRequest.payload, env);
        storedPayload = JSON.stringify(signedEnvelope);
        } else if (isDropPayload(parsedRequest.payload)) {
          if (!parsedRequest.payload.content.trim()) {
            return new Response("Request body cannot be empty.", { status: 400 });
          }

          storedPayload = JSON.stringify({
            content: parsedRequest.payload.content,
            metadata: parsedRequest.payload.metadata || {},
            draftPack: parsedRequest.payload.draftPack,
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

    let id: string | null = null;

    if (requestedId) {
      const aliasState = await reserveRemoteAlias(env.R2_BUCKET, requestedId);
      if (aliasState === "conflict") {
        return new Response("Drop short link is already in use.", { status: 409 });
      }

      let stored = false;

      try {
        stored = await putDropObject(
          env.R2_BUCKET,
          requestedId,
          storedPayload,
          storedContentType,
          upsert,
        );
      } catch (error) {
        if (aliasState === "reserved") {
          await removeRemoteAliasIfMatch(env.R2_BUCKET, requestedId);
        }

        throw error;
      }

      if (!stored) {
        return new Response("Drop ID already exists.", { status: 409 });
      }

      id = requestedId;
    } else {
      for (let attempt = 0; attempt < MAX_ID_ALLOCATION_ATTEMPTS; attempt += 1) {
        const candidateId = generateDropId(DROP_ID_LENGTH);
        const aliasState = await reserveRemoteAlias(env.R2_BUCKET, candidateId);
        if (aliasState === "conflict") {
          continue;
        }

        let stored = false;

        try {
          stored = await putDropObject(
            env.R2_BUCKET,
            candidateId,
            storedPayload,
            storedContentType,
            false,
          );
        } catch (error) {
          if (aliasState === "reserved") {
            await removeRemoteAliasIfMatch(env.R2_BUCKET, candidateId);
          }

          throw error;
        }

        if (stored) {
          id = candidateId;
          break;
        }

        if (aliasState === "reserved") {
          await removeRemoteAliasIfMatch(env.R2_BUCKET, candidateId);
        }
      }
    }

    if (!id) {
      return new Response("Failed to allocate a unique drop ID.", { status: 500 });
    }

    const baseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, "");
    const dropUrl = `${baseUrl}/d/${toShortDropId(id)}`;

    return new Response(JSON.stringify({ id, url: dropUrl }), {
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

export const onRequest: PagesFunction<Env> = async ({ request }) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  return new Response("Endpoint requires POST method", { status: 405 });
};

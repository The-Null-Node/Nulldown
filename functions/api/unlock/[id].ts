import type { PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import { isDropEnvelopeV1 } from "../../../shared/drop/types";
import { resolveRemoteDropId } from "../_lib/dropId";

interface Env {
  R2_BUCKET: R2Bucket;
  PROVIDER_ENCRYPTION_PRIVATE_JWK?: string;
}

interface UnlockRequestBody {
  requesterPublicJwk?: JsonWebKey;
}

const resolveId = (id: string | string[] | undefined) =>
  typeof id === "string" ? id : Array.isArray(id) ? id[0] : "";

const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
};

const toBase64 = (value: ArrayBuffer): string => {
  const bytes = new Uint8Array(value);
  let binary = "";

  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary);
};

const parseProviderPrivateKey = async (raw: string): Promise<CryptoKey> => {
  const jwk = JSON.parse(raw) as JsonWebKey;
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    {
      name: "RSA-OAEP",
      hash: "SHA-256",
    },
    false,
    ["decrypt"],
  );
};

const parseRequesterPublicKey = async (jwk: JsonWebKey): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "jwk",
    jwk,
    {
      name: "RSA-OAEP",
      hash: "SHA-256",
    },
    false,
    ["encrypt"],
  );

export const onRequestPost: PagesFunction<Env, "id"> = async ({
  env,
  params,
  request,
}) => {
  try {
    if (!env.R2_BUCKET) {
      return new Response("R2 bucket binding is required.", { status: 500 });
    }

    if (!env.PROVIDER_ENCRYPTION_PRIVATE_JWK) {
      return new Response("Provider escrow key is not configured.", { status: 501 });
    }

    const requestedId = resolveId(params.id);
    const id = await resolveRemoteDropId(env.R2_BUCKET, requestedId);
    if (!id) {
      return new Response("Drop ID is required.", { status: 400 });
    }

    const body = (await request.json()) as UnlockRequestBody;
    if (!body.requesterPublicJwk) {
      return new Response("requesterPublicJwk is required.", { status: 400 });
    }

    const object = await env.R2_BUCKET.get(id);
    if (!object) {
      return new Response("Drop not found.", { status: 404 });
    }

    const serialized = await new Response(object.body).text();
    let parsed: unknown;

    try {
      parsed = JSON.parse(serialized);
    } catch {
      return new Response("Drop payload is not JSON.", { status: 400 });
    }

    if (!isDropEnvelopeV1(parsed)) {
      return new Response("Drop payload is not an encrypted envelope.", {
        status: 400,
      });
    }

    if (parsed.unlockPolicy !== "provider-escrow" || !parsed.providerEscrow) {
      return new Response("Drop does not allow provider escrow unlock.", {
        status: 403,
      });
    }

    const providerPrivateKey = await parseProviderPrivateKey(
      env.PROVIDER_ENCRYPTION_PRIVATE_JWK,
    );
    const requesterPublicKey = await parseRequesterPublicKey(
      body.requesterPublicJwk,
    );

    const rawContentKey = await crypto.subtle.decrypt(
      {
        name: "RSA-OAEP",
      },
      providerPrivateKey,
      fromBase64(parsed.providerEscrow.wrappedKey),
    );

    const requesterWrappedKey = await crypto.subtle.encrypt(
      {
        name: "RSA-OAEP",
      },
      requesterPublicKey,
      rawContentKey,
    );

    return new Response(
      JSON.stringify({
        wrappedKey: toBase64(requesterWrappedKey),
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error: unknown) {
    console.error("Error unlocking drop:", error);
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Failed to unlock drop: ${message}`, { status: 500 });
  }
};

export const onRequest: PagesFunction<Env, "id"> = async (context) => {
  if (context.request.method === "POST") {
    return onRequestPost(context);
  }

  return new Response("Method Not Allowed", { status: 405 });
};

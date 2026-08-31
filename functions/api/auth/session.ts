import type { D1Database, PagesFunction, R2Bucket } from "@cloudflare/workers-types";
import {
  canonicalizeAccountEncryptionRecipient,
  issueAccountSessionToken,
  pinAccountEncryptionRecipient,
  putAccountRecord,
  readAccountRecord,
  reserveAccountRecord,
  sanitizeAccountId,
  verifyAccountProof,
  type AccountAuthEnv,
} from "../_lib/accounts/session/auth";

interface Env extends AccountAuthEnv {
  R2_BUCKET: R2Bucket;
  DB?: D1Database;
}

interface AccountSessionRequest {
  accountId?: string;
  signingPublicJwk?: JsonWebKey;
  encryptionKid?: string;
  encryptionPublicJwk?: JsonWebKey;
  signedAt?: number;
  signature?: string;
}

const parseBody = async (
  request: Request,
): Promise<AccountSessionRequest | null> => {
  try {
    const parsed = (await request.json()) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    return parsed as AccountSessionRequest;
  } catch {
    return null;
  }
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.R2_BUCKET) {
    return new Response("R2 bucket binding is required.", { status: 500 });
  }
  if (!env.ACCOUNT_AUTH_SECRET) {
    return new Response("ACCOUNT_AUTH_SECRET is required.", { status: 503 });
  }

  const body = await parseBody(request);
  if (!body) {
    return new Response("Invalid JSON body.", { status: 400 });
  }

  const accountId = sanitizeAccountId(body.accountId);
  if (!accountId) {
    return new Response("Valid accountId is required.", { status: 400 });
  }

  if (
    !body.signingPublicJwk ||
    typeof body.signedAt !== "number" ||
    !body.signature
  ) {
    return new Response(
      "signingPublicJwk, signedAt, and signature are required.",
      {
        status: 400,
      },
    );
  }

  const hasRecipient =
    body.encryptionKid !== undefined || body.encryptionPublicJwk !== undefined;
  const recipient = hasRecipient
    ? await canonicalizeAccountEncryptionRecipient({
        encryptionKid: body.encryptionKid,
        encryptionPublicJwk: body.encryptionPublicJwk,
      })
    : null;
  if (hasRecipient && !recipient) {
    return new Response("Valid public encryption recipient is required.", { status: 400 });
  }

  const existing = await readAccountRecord(env.R2_BUCKET, accountId, env.DB);
  const expectedPublicJwk = existing?.signingPublicJwk ?? body.signingPublicJwk;

  const validProof = await verifyAccountProof({
    accountId,
    signingPublicJwk: expectedPublicJwk,
    signedAt: body.signedAt,
    signature: body.signature,
    ...(recipient ? { recipient } : {}),
  });

  if (!validProof) {
    return new Response("Account proof verification failed.", { status: 401 });
  }

  const now = Date.now();
  const record = {
    version: 1 as const,
    accountId,
    signingPublicJwk: expectedPublicJwk,
    ...(recipient
      ? recipient
      : existing?.encryptionKid && existing.encryptionPublicJwk
        ? {
            encryptionKid: existing.encryptionKid,
            encryptionPublicJwk: existing.encryptionPublicJwk,
          }
        : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  let persisted = record;
  if (existing) {
    if (recipient) {
      const pinned = await pinAccountEncryptionRecipient(
        env.R2_BUCKET,
        existing,
        recipient,
        env.DB,
      );
      if (!pinned) {
        return new Response("Account encryption recipient is immutable.", { status: 409 });
      }
      persisted = pinned;
    } else {
      await putAccountRecord(env.R2_BUCKET, record, env.DB);
    }
  } else {
    const reserved = await reserveAccountRecord(env.R2_BUCKET, record, env.DB);
    if (
      !reserved ||
      reserved.signingPublicJwk.x !== expectedPublicJwk.x ||
      reserved.signingPublicJwk.y !== expectedPublicJwk.y
    ) {
      return new Response("Account proof verification failed.", { status: 401 });
    }
    persisted = recipient
      ? await pinAccountEncryptionRecipient(env.R2_BUCKET, reserved, recipient, env.DB)
      : reserved;
    if (!persisted) {
      return new Response("Account encryption recipient is immutable.", { status: 409 });
    }
  }

  const issued = await issueAccountSessionToken(accountId, env);
  return new Response(
    JSON.stringify({
      token: issued.token,
      expiresAt: issued.payload.exp,
      accountId: issued.payload.accountId,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    },
  );
};

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method === "POST") {
    return onRequestPost(context);
  }

  return new Response("Method Not Allowed", { status: 405 });
};

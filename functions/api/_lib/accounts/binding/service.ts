import type { D1Database } from "@cloudflare/workers-types";

import {
  ACCOUNT_BINDING_CHALLENGE_SCHEMA_V1,
  ACCOUNT_BINDING_OPERATION_V1,
  parseAccountBindingChallenge,
  serializeAccountBindingChallenge,
  type AccountBindingChallengeV1,
} from "../../../../../shared/auth/accountBinding";
import type { VoidBlobStore, VoidSqlStore } from "../../../../../src/server/ports";
import {
  readAccountRecord,
  resolveAuthenticatedAccountId,
} from "../session/auth";
import {
  isSameOriginOpenAuthRequest,
  resolveOpenAuthRequestIdentity,
  type OpenAuthBffEnvironment,
  type OpenAuthRequestIdentity,
} from "../openAuth/service";
import {
  consumeAccountBindingChallenge,
  createAccountBindingChallenge,
  insertAccountBinding,
  readAccountBinding,
  readAccountBindingChallenge,
} from "./repository";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const textEncoder = new TextEncoder();

export interface AccountBindingEnvironment extends OpenAuthBffEnvironment {
  R2_BUCKET?: VoidBlobStore;
  ACCOUNT_AUTH_SECRET?: string;
  ACCOUNT_AUTH_TOKEN_TTL_MS?: string;
  ALLOW_INSECURE_ACCOUNT_HEADER?: string;
}

const responseJson = (
  body: unknown,
  status: number,
  identity?: OpenAuthRequestIdentity,
): Response => {
  const headers = new Headers(identity?.responseHeaders);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
};

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const fromBase64Url = (value: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
};

const randomToken = (): string =>
  toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

const hashToken = async (value: string): Promise<string> =>
  toBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(value))),
  );

/** Stable fingerprint for the already pinned account verification key. */
export const fingerprintAccountSigningKey = async (
  signingPublicJwk: JsonWebKey,
): Promise<string> => {
  const canonical = JSON.stringify({
    kty: signingPublicJwk.kty,
    crv: signingPublicJwk.crv,
    x: signingPublicJwk.x,
    y: signingPublicJwk.y,
  });
  return `sha256:${await hashToken(canonical)}`;
};

const resolveDualAuthority = async (
  env: AccountBindingEnvironment,
  request: Request,
): Promise<
  | { identity: OpenAuthRequestIdentity; accountId: string; bucket: VoidBlobStore }
  | Response
> => {
  const identity = await resolveOpenAuthRequestIdentity(env, request);
  if (identity instanceof Response) return identity;
  if (!isSameOriginOpenAuthRequest(request, identity.origin)) {
    return responseJson({ error: "invalid_origin" }, 403, identity);
  }
  if (!env.R2_BUCKET) {
    return responseJson({ error: "account_storage_unavailable" }, 503, identity);
  }
  if (!env.ACCOUNT_AUTH_SECRET) {
    return responseJson({ error: "account_auth_unavailable" }, 503, identity);
  }
  if (!request.headers.get("Authorization")?.startsWith("Bearer ")) {
    return responseJson({ error: "account_auth_required" }, 401, identity);
  }
  const accountId = await resolveAuthenticatedAccountId(request, env);
  if (!accountId) return responseJson({ error: "account_auth_required" }, 401, identity);
  return { identity, accountId, bucket: env.R2_BUCKET };
};

/** Creates a challenge bound to both current user and current V1 account authority. */
export const createBindingChallengeResponse = async (
  env: AccountBindingEnvironment,
  request: Request,
): Promise<Response> => {
  const authority = await resolveDualAuthority(env, request);
  if (authority instanceof Response) return authority;
  const { identity, accountId, bucket } = authority;

  const account = await readAccountRecord(
    bucket,
    accountId,
    identity.db as unknown as VoidSqlStore,
  );
  if (!account) return responseJson({ error: "account_not_registered" }, 409, identity);

  const existing = await readAccountBinding(identity.db, accountId);
  if (existing) {
    return existing.user_id === identity.userId
      ? responseJson({ bound: true, accountId }, 200, identity)
      : responseJson({ error: "account_already_bound" }, 409, identity);
  }

  const issuedAt = Date.now();
  const challenge: AccountBindingChallengeV1 = {
    schema: ACCOUNT_BINDING_CHALLENGE_SCHEMA_V1,
    version: 1,
    operation: ACCOUNT_BINDING_OPERATION_V1,
    challengeId: randomToken(),
    nonce: randomToken(),
    userId: identity.userId,
    accountId,
    origin: identity.origin,
    signingKeyFingerprint: await fingerprintAccountSigningKey(account.signingPublicJwk),
    issuedAt,
    expiresAt: issuedAt + CHALLENGE_TTL_MS,
  };
  await createAccountBindingChallenge(identity.db, {
    challenge_id: challenge.challengeId,
    nonce_hash: await hashToken(challenge.nonce),
    user_id: challenge.userId,
    account_id: challenge.accountId,
    origin: challenge.origin,
    signing_key_fingerprint: challenge.signingKeyFingerprint,
    issued_at: challenge.issuedAt,
    expires_at: challenge.expiresAt,
    consumed_at: null,
  });
  return responseJson({ bound: false, challenge }, 201, identity);
};

export const verifyAccountSignature = async (
  publicJwk: JsonWebKey,
  serializedValue: string,
  signature: string,
): Promise<boolean> => {
  const signatureBytes = fromBase64Url(signature);
  if (!signatureBytes) return false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      publicJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signatureBytes,
      textEncoder.encode(serializedValue),
    );
  } catch {
    return false;
  }
};

/** Consumes a valid challenge and establishes immutable V1 account ownership. */
export const bindAccountResponse = async (
  env: AccountBindingEnvironment,
  request: Request,
): Promise<Response> => {
  const authority = await resolveDualAuthority(env, request);
  if (authority instanceof Response) return authority;
  const { identity, accountId, bucket } = authority;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return responseJson({ error: "invalid_binding_request" }, 400, identity);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return responseJson({ error: "invalid_binding_request" }, 400, identity);
  }
  const requestBody = body as Record<string, unknown>;
  const challenge = parseAccountBindingChallenge(requestBody.challenge);
  const signature = requestBody.signature;
  if (!challenge || typeof signature !== "string" || Object.keys(requestBody).length !== 2) {
    return responseJson({ error: "invalid_binding_request" }, 400, identity);
  }

  const existing = await readAccountBinding(identity.db, accountId);
  if (existing) {
    return existing.user_id === identity.userId
      ? responseJson({ bound: true, accountId }, 200, identity)
      : responseJson({ error: "account_already_bound" }, 409, identity);
  }

  const persisted = await readAccountBindingChallenge(identity.db, challenge.challengeId);
  if (
    !persisted ||
    persisted.consumed_at !== null ||
    persisted.expires_at <= Date.now() ||
    persisted.user_id !== identity.userId ||
    persisted.account_id !== accountId ||
    persisted.origin !== identity.origin ||
    persisted.signing_key_fingerprint !== challenge.signingKeyFingerprint ||
    persisted.issued_at !== challenge.issuedAt ||
    persisted.expires_at !== challenge.expiresAt ||
    (await hashToken(challenge.nonce)) !== persisted.nonce_hash ||
    challenge.userId !== identity.userId ||
    challenge.accountId !== accountId ||
    challenge.origin !== identity.origin
  ) {
    return responseJson({ error: "invalid_binding_challenge" }, 409, identity);
  }

  const account = await readAccountRecord(
    bucket,
    accountId,
    identity.db as unknown as VoidSqlStore,
  );
  if (
    !account ||
    (await fingerprintAccountSigningKey(account.signingPublicJwk)) !==
      challenge.signingKeyFingerprint ||
    !(await verifyAccountSignature(
      account.signingPublicJwk,
      serializeAccountBindingChallenge(challenge),
      signature,
    ))
  ) {
    return responseJson({ error: "invalid_binding_signature" }, 401, identity);
  }

  const now = Date.now();
  if (!(await consumeAccountBindingChallenge(identity.db, challenge.challengeId, now))) {
    return responseJson({ error: "invalid_binding_challenge" }, 409, identity);
  }
  await insertAccountBinding(identity.db, {
    account_id: accountId,
    user_id: identity.userId,
    signing_key_fingerprint: challenge.signingKeyFingerprint,
    created_at: now,
    updated_at: now,
  });
  const bound = await readAccountBinding(identity.db, accountId);
  if (!bound || bound.user_id !== identity.userId) {
    return responseJson({ error: "account_already_bound" }, 409, identity);
  }
  return responseJson({ bound: true, accountId }, 201, identity);
};

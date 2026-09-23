import { sanitizeAccountId } from "../identity/records";
import type { AccountAuthEnv } from "./authentication";

/** Signed account session token payload. */
export interface AccountSessionTokenPayload {
  version: 1;
  accountId: string;
  credentialId?: string;
  iat: number;
  exp: number;
}

/** Server-selected claims for a signed account session token. */
export interface AccountSessionTokenOptions {
  credentialId?: string;
}

const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const ACCOUNT_TOKEN_PREFIX = "ndacc.v1";
const DEFAULT_ACCOUNT_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const toBase64Url = (input: string | Uint8Array): string => {
  const bytes = typeof input === "string" ? textEncoder.encode(input) : input;
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

const fromBase64Url = (value: string): Uint8Array => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const timingSafeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a[index] ^ b[index];
  }
  return diff === 0;
};

const parseTokenTtlMs = (value: string | undefined): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_ACCOUNT_TOKEN_TTL_MS;
  }
  return parsed;
};

const signAccountTokenDigest = async (
  secret: string,
  payloadPart: string,
): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(payloadPart),
  );
  return new Uint8Array(signature);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseAccountTokenPayload = (
  value: unknown,
): AccountSessionTokenPayload | null => {
  if (!isRecord(value)) return null;
  if (value.version !== 1) return null;
  if (typeof value.accountId !== "string") return null;
  if (
    value.credentialId !== undefined &&
    (typeof value.credentialId !== "string" ||
      !CREDENTIAL_ID_PATTERN.test(value.credentialId))
  ) {
    return null;
  }
  if (typeof value.iat !== "number" || !Number.isFinite(value.iat)) return null;
  if (typeof value.exp !== "number" || !Number.isFinite(value.exp)) return null;

  const accountId = sanitizeAccountId(value.accountId);
  if (!accountId) {
    return null;
  }

  return {
    version: 1,
    accountId,
    ...(value.credentialId === undefined
      ? {}
      : { credentialId: value.credentialId }),
    iat: value.iat,
    exp: value.exp,
  };
};

/** Issues an HMAC-signed account session token for an authenticated account. */
export const issueAccountSessionToken = async (
  accountId: string,
  env: AccountAuthEnv,
  options: AccountSessionTokenOptions = {},
): Promise<{ token: string; payload: AccountSessionTokenPayload }> => {
  const secret = env.ACCOUNT_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "ACCOUNT_AUTH_SECRET is required to issue account session tokens.",
    );
  }
  if (
    options.credentialId !== undefined &&
    !CREDENTIAL_ID_PATTERN.test(options.credentialId)
  ) {
    throw new TypeError("Account session credential id is invalid.");
  }

  const ttlMs = parseTokenTtlMs(env.ACCOUNT_AUTH_TOKEN_TTL_MS);
  const now = Date.now();
  const payload: AccountSessionTokenPayload = {
    version: 1,
    accountId,
    ...(options.credentialId === undefined
      ? {}
      : { credentialId: options.credentialId }),
    iat: now,
    exp: now + ttlMs,
  };

  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signingInput = `${ACCOUNT_TOKEN_PREFIX}.${encodedPayload}`;
  const signature = await signAccountTokenDigest(secret, signingInput);
  const encodedSignature = toBase64Url(signature);

  return {
    token: `${signingInput}.${encodedSignature}`,
    payload,
  };
};

/** Verifies an HMAC-signed account session token and returns its payload. */
export const verifyAccountSessionToken = async (
  token: string,
  env: AccountAuthEnv,
): Promise<AccountSessionTokenPayload | null> => {
  const secret = env.ACCOUNT_AUTH_SECRET;
  if (!secret) {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 4) {
    return null;
  }

  const [prefixA, prefixB, encodedPayload, encodedSignature] = parts;
  if (`${prefixA}.${prefixB}` !== ACCOUNT_TOKEN_PREFIX) {
    return null;
  }

  let payloadJson: unknown;
  try {
    payloadJson = JSON.parse(
      textDecoder.decode(fromBase64Url(encodedPayload)),
    ) as unknown;
  } catch {
    return null;
  }

  const payload = parseAccountTokenPayload(payloadJson);
  if (!payload) {
    return null;
  }

  const now = Date.now();
  if (payload.exp <= now) {
    return null;
  }

  const signingInput = `${ACCOUNT_TOKEN_PREFIX}.${encodedPayload}`;
  const expectedSignature = await signAccountTokenDigest(secret, signingInput);
  let providedSignature: Uint8Array;
  try {
    providedSignature = fromBase64Url(encodedSignature);
  } catch {
    return null;
  }

  if (!timingSafeEqual(expectedSignature, providedSignature)) {
    return null;
  }

  return payload;
};

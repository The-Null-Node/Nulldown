import { NULLDOWN_ACCOUNT_ID_HEADER } from "../../../../../shared/drop/branch";
import type { VoidBlobStore, VoidSqlStore } from "../../../../../src/server/ports";

const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const ACCOUNT_TOKEN_PREFIX = "ndacc.v1";
const DEFAULT_ACCOUNT_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

/** Environment bindings used by account authentication services. */
export interface AccountAuthEnv {
  R2_BUCKET?: VoidBlobStore;
  DB?: VoidSqlStore;
  ACCOUNT_AUTH_SECRET?: string;
  ACCOUNT_AUTH_TOKEN_TTL_MS?: string;
  ALLOW_INSECURE_ACCOUNT_HEADER?: string;
}

/** Persisted account signing record stored for authenticated account sessions. */
export interface AccountRecordV1 {
  version: 1;
  accountId: string;
  signingPublicJwk: JsonWebKey;
  createdAt: number;
  updatedAt: number;
}

/** Signed account session token payload. */
export interface AccountSessionTokenPayload {
  version: 1;
  accountId: string;
  iat: number;
  exp: number;
}

/** R2 prefix for persisted account auth records. */
export const ACCOUNT_RECORD_PREFIX = "__account_auth__/accounts/";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const toBase64Url = (input: string | Uint8Array): string => {
  const bytes = typeof input === "string" ? textEncoder.encode(input) : input;
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
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

const accountRecordKey = (accountId: string) =>
  `${ACCOUNT_RECORD_PREFIX}${accountId}.json`;

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
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(payloadPart));
  return new Uint8Array(signature);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isEcP256PublicJwk = (value: unknown): value is JsonWebKey => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.kty === "EC" &&
    value.crv === "P-256" &&
    typeof value.x === "string" &&
    typeof value.y === "string"
  );
};

/** Returns true when a value is a persisted account auth record. */
export const isAccountRecord = (value: unknown): value is AccountRecordV1 => {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (typeof value.accountId !== "string") return false;
  if (!isEcP256PublicJwk(value.signingPublicJwk)) return false;
  if (typeof value.createdAt !== "number") return false;
  if (typeof value.updatedAt !== "number") return false;
  return true;
};

const parseAccountTokenPayload = (
  value: unknown,
): AccountSessionTokenPayload | null => {
  if (!isRecord(value)) return null;
  if (value.version !== 1) return null;
  if (typeof value.accountId !== "string") return null;
  if (typeof value.iat !== "number" || !Number.isFinite(value.iat)) return null;
  if (typeof value.exp !== "number" || !Number.isFinite(value.exp)) return null;

  const accountId = sanitizeAccountId(value.accountId);
  if (!accountId) {
    return null;
  }

  return {
    version: 1,
    accountId,
    iat: value.iat,
    exp: value.exp,
  };
};

/** Normalizes and validates a user-controlled account identifier. */
export const sanitizeAccountId = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || !ACCOUNT_ID_PATTERN.test(trimmed)) {
    return null;
  }

  return trimmed;
};

/** Reads an insecure development account id header when explicitly enabled. */
export const readRequestAccountId = (request: Request): string | null =>
  sanitizeAccountId(request.headers.get(NULLDOWN_ACCOUNT_ID_HEADER));

const readBearerToken = (request: Request): string | null => {
  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice("Bearer ".length).trim();
  return token || null;
};

/** Issues an HMAC-signed account session token for an authenticated account. */
export const issueAccountSessionToken = async (
  accountId: string,
  env: AccountAuthEnv,
): Promise<{ token: string; payload: AccountSessionTokenPayload }> => {
  const secret = env.ACCOUNT_AUTH_SECRET;
  if (!secret) {
    throw new Error("ACCOUNT_AUTH_SECRET is required to issue account session tokens.");
  }

  const ttlMs = parseTokenTtlMs(env.ACCOUNT_AUTH_TOKEN_TTL_MS);
  const now = Date.now();
  const payload: AccountSessionTokenPayload = {
    version: 1,
    accountId,
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
    payloadJson = JSON.parse(textDecoder.decode(fromBase64Url(encodedPayload)));
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
  const providedSignature = fromBase64Url(encodedSignature);

  if (!timingSafeEqual(expectedSignature, providedSignature)) {
    return null;
  }

  return payload;
};

/** Resolves the authenticated account id from bearer token or allowed dev header. */
export const resolveAuthenticatedAccountId = async (
  request: Request,
  env: AccountAuthEnv,
): Promise<string | null> => {
  const bearerToken = readBearerToken(request);
  if (bearerToken) {
    const payload = await verifyAccountSessionToken(bearerToken, env);
    if (payload) {
      return payload.accountId;
    }
    return null;
  }

  const shouldAllowInsecureHeader =
    env.ALLOW_INSECURE_ACCOUNT_HEADER === "1" || !env.ACCOUNT_AUTH_SECRET;
  if (!shouldAllowInsecureHeader) {
    return null;
  }

  return readRequestAccountId(request);
};

/** Reads a persisted account record by account id. */
export const readAccountRecord = async (
  bucket: VoidBlobStore,
  accountId: string,
  db?: VoidSqlStore,
): Promise<AccountRecordV1 | null> => {
  if (db) {
    const row = await db
      .prepare(
        `SELECT account_id, signing_public_jwk, created_at, updated_at
         FROM accounts
         WHERE account_id = ?`,
      )
      .bind(accountId)
      .first<{
        account_id: string;
        signing_public_jwk: string;
        created_at: number;
        updated_at: number;
      }>();
    if (row) {
      try {
        const signingPublicJwk = JSON.parse(row.signing_public_jwk) as unknown;
        const record = {
          version: 1 as const,
          accountId: row.account_id,
          signingPublicJwk,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
        if (isAccountRecord(record)) return record;
      } catch {
        return null;
      }
    }
  }

  const object = await bucket.get(accountRecordKey(accountId));
  if (!object?.body) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = await object.json<unknown>();
  } catch {
    return null;
  }

  const record = isAccountRecord(parsed) ? parsed : null;
  if (record && db) {
    await putAccountRecord(bucket, record, db);
  }
  return record;
};

/** Writes the current account signing record to D1 and R2 fallback storage. */
export const putAccountRecord = async (
  bucket: VoidBlobStore,
  record: AccountRecordV1,
  db?: VoidSqlStore,
): Promise<void> => {
  if (db) {
    await db
      .prepare(
        `INSERT INTO accounts (account_id, signing_public_jwk, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           signing_public_jwk = excluded.signing_public_jwk,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.accountId,
        JSON.stringify(record.signingPublicJwk),
        record.createdAt,
        record.updatedAt,
      )
      .run();
  }
  await bucket.put(accountRecordKey(record.accountId), JSON.stringify(record), {
    httpMetadata: { contentType: "application/json" },
  });
};

/** Verifies a signed account proof against the account public key. */
export const verifyAccountProof = async (input: {
  accountId: string;
  signingPublicJwk: JsonWebKey;
  signedAt: number;
  signature: string;
}): Promise<boolean> => {
  if (!isEcP256PublicJwk(input.signingPublicJwk)) {
    return false;
  }

  const skew = Math.abs(Date.now() - input.signedAt);
  if (skew > 5 * 60 * 1000) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "jwk",
    input.signingPublicJwk,
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    false,
    ["verify"],
  );

  const message = `nulldown-account-auth\n${input.accountId}\n${input.signedAt}`;
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = fromBase64Url(input.signature);
  } catch {
    return false;
  }

  return crypto.subtle.verify(
    {
      name: "ECDSA",
      hash: "SHA-256",
    },
    key,
    signatureBytes,
    textEncoder.encode(message),
  );
};

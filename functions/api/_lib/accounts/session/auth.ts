import { NULLDOWN_ACCOUNT_ID_HEADER } from "../../../../../shared/drop/branch";
import type { VoidBlobStore, VoidSqlStore } from "../../../../../src/server/ports";
import { serializeCanonicalJson } from "../../../../../shared/drop/types";

const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const ENCRYPTION_KID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const ACCOUNT_TOKEN_PREFIX = "ndacc.v1";
const DEFAULT_ACCOUNT_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

/** Minimal request surface shared by browser and Workers account-auth routes. */
export interface AccountAuthRequest {
  headers: { get(name: string): string | null };
}

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
  encryptionKid?: string;
  encryptionPublicJwk?: JsonWebKey;
  createdAt: number;
  updatedAt: number;
}

/** Canonical public encryption material authorized by an account signing key. */
export interface AccountEncryptionRecipient {
  encryptionKid: string;
  encryptionPublicJwk: JsonWebKey;
}

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

const hasPrivateJwkMaterial = (value: Record<string, unknown>): boolean =>
  ["d", "p", "q", "dp", "dq", "qi", "k"].some((key) => key in value);

const isEcP256PublicJwk = (value: unknown): value is JsonWebKey => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    !hasPrivateJwkMaterial(value) &&
    value.kty === "EC" &&
    value.crv === "P-256" &&
    typeof value.x === "string" &&
    typeof value.y === "string"
  );
};

const isCanonicalEncryptionPublicJwk = (value: unknown): value is JsonWebKey =>
  isRecord(value) &&
  !hasPrivateJwkMaterial(value) &&
  value.kty === "RSA" &&
  typeof value.n === "string" &&
  value.n.length >= 256 &&
  value.n.length <= 1024 &&
  BASE64_URL_PATTERN.test(value.n) &&
  typeof value.e === "string" &&
  value.e.length >= 3 &&
  value.e.length <= 16 &&
  BASE64_URL_PATTERN.test(value.e) &&
  Object.keys(value).every((key) => key === "kty" || key === "n" || key === "e");

const samePublicSigningKey = (left: JsonWebKey, right: JsonWebKey): boolean =>
  left.kty === right.kty &&
  left.crv === right.crv &&
  left.x === right.x &&
  left.y === right.y;

/** Returns true when a value is a persisted account auth record. */
export const isAccountRecord = (value: unknown): value is AccountRecordV1 => {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (typeof value.accountId !== "string") return false;
  if (!isEcP256PublicJwk(value.signingPublicJwk)) return false;
  const hasEncryptionKid = value.encryptionKid !== undefined;
  const hasEncryptionPublicJwk = value.encryptionPublicJwk !== undefined;
  if (hasEncryptionKid !== hasEncryptionPublicJwk) return false;
  if (
    hasEncryptionKid &&
    (!isAccountEncryptionRecipient({
      encryptionKid: value.encryptionKid,
      encryptionPublicJwk: value.encryptionPublicJwk,
    }))
  ) {
    return false;
  }
  if (typeof value.createdAt !== "number") return false;
  if (typeof value.updatedAt !== "number") return false;
  return true;
};

/** Returns true for a canonical, non-secret account encryption recipient. */
export const isAccountEncryptionRecipient = (
  value: unknown,
): value is AccountEncryptionRecipient =>
  isRecord(value) &&
  typeof value.encryptionKid === "string" &&
  ENCRYPTION_KID_PATTERN.test(value.encryptionKid) &&
  isCanonicalEncryptionPublicJwk(value.encryptionPublicJwk);

/** Removes optional JWK metadata before it is signed or persisted as recipient authority. */
export const canonicalizeAccountEncryptionRecipient = async (
  value: unknown,
): Promise<AccountEncryptionRecipient | null> => {
  if (
    !isRecord(value) ||
    !isRecord(value.encryptionPublicJwk) ||
    hasPrivateJwkMaterial(value.encryptionPublicJwk)
  ) {
    return null;
  }
  const recipient = {
    encryptionKid: value.encryptionKid,
    encryptionPublicJwk: {
      kty: value.encryptionPublicJwk.kty,
      n: value.encryptionPublicJwk.n,
      e: value.encryptionPublicJwk.e,
    },
  };
  if (!isAccountEncryptionRecipient(recipient)) return null;

  try {
    await crypto.subtle.importKey(
      "jwk",
      recipient.encryptionPublicJwk,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );
    return recipient;
  } catch {
    return null;
  }
};

/** Serializes the exact account proof bytes, preserving the legacy shape without a recipient. */
export const serializeAccountProof = (
  accountId: string,
  signedAt: number,
  recipient?: AccountEncryptionRecipient,
): string =>
  recipient
    ? `nulldown-account-auth\n${accountId}\n${signedAt}\n${serializeCanonicalJson(recipient)}`
    : `nulldown-account-auth\n${accountId}\n${signedAt}`;

const sameAccountEncryptionRecipient = (
  left: AccountEncryptionRecipient | undefined,
  right: AccountEncryptionRecipient | undefined,
): boolean => {
  if (!left || !right) return false;
  return (
    left.encryptionKid === right.encryptionKid &&
    serializeCanonicalJson(left.encryptionPublicJwk) ===
      serializeCanonicalJson(right.encryptionPublicJwk)
  );
};

const parseAccountTokenPayload = (
  value: unknown,
): AccountSessionTokenPayload | null => {
  if (!isRecord(value)) return null;
  if (value.version !== 1) return null;
  if (typeof value.accountId !== "string") return null;
  if (
    value.credentialId !== undefined &&
    (typeof value.credentialId !== "string" || !CREDENTIAL_ID_PATTERN.test(value.credentialId))
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
    ...(value.credentialId === undefined ? {} : { credentialId: value.credentialId }),
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
export const readRequestAccountId = (request: AccountAuthRequest): string | null =>
  sanitizeAccountId(request.headers.get(NULLDOWN_ACCOUNT_ID_HEADER));

const readBearerToken = (request: AccountAuthRequest): string | null => {
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
  options: AccountSessionTokenOptions = {},
): Promise<{ token: string; payload: AccountSessionTokenPayload }> => {
  const secret = env.ACCOUNT_AUTH_SECRET;
  if (!secret) {
    throw new Error("ACCOUNT_AUTH_SECRET is required to issue account session tokens.");
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
    ...(options.credentialId === undefined ? {} : { credentialId: options.credentialId }),
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

/** Resolves the authenticated account id from bearer token or allowed dev header. */
export const resolveAuthenticatedAccountId = async (
  request: AccountAuthRequest,
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
  bucket: VoidBlobStore | undefined,
  accountId: string,
  db?: VoidSqlStore,
): Promise<AccountRecordV1 | null> => {
  if (db) {
    const row = await db
      .prepare(
         `SELECT account_id, signing_public_jwk, encryption_kid, encryption_public_jwk, created_at, updated_at
         FROM accounts
         WHERE account_id = ?`,
      )
      .bind(accountId)
      .first<{
         account_id: string;
         signing_public_jwk: string;
         encryption_kid?: string | null;
         encryption_public_jwk?: string | null;
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
          ...(row.encryption_kid && row.encryption_public_jwk
            ? {
                encryptionKid: row.encryption_kid,
                encryptionPublicJwk: JSON.parse(row.encryption_public_jwk) as unknown,
              }
            : {}),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
        if (isAccountRecord(record)) return record;
      } catch {
        // A corrupt D1 projection must not hide a valid R2 account record.
      }
    }
  }

  if (!bucket) return null;
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
         `INSERT INTO accounts (account_id, signing_public_jwk, encryption_kid, encryption_public_jwk, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(account_id) DO UPDATE SET
            signing_public_jwk = excluded.signing_public_jwk,
            encryption_kid = excluded.encryption_kid,
            encryption_public_jwk = excluded.encryption_public_jwk,
            updated_at = excluded.updated_at`,
      )
      .bind(
        record.accountId,
        JSON.stringify(record.signingPublicJwk),
        record.encryptionKid ?? null,
        record.encryptionPublicJwk ? JSON.stringify(record.encryptionPublicJwk) : null,
        record.createdAt,
        record.updatedAt,
      )
      .run();
  }
  await bucket.put(accountRecordKey(record.accountId), JSON.stringify(record), {
    httpMetadata: { contentType: "application/json" },
  });
};

/** Reserves an account's first signing key without allowing a competing key to replace it. */
export const reserveAccountRecord = async (
  bucket: VoidBlobStore,
  record: AccountRecordV1,
  db?: VoidSqlStore,
): Promise<AccountRecordV1 | null> => {
  if (db) {
    await db
      .prepare(
         `INSERT INTO accounts (account_id, signing_public_jwk, encryption_kid, encryption_public_jwk, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO NOTHING`,
      )
      .bind(
        record.accountId,
        JSON.stringify(record.signingPublicJwk),
        record.encryptionKid ?? null,
        record.encryptionPublicJwk ? JSON.stringify(record.encryptionPublicJwk) : null,
        record.createdAt,
        record.updatedAt,
      )
      .run();

    const persisted = await readAccountRecord(bucket, record.accountId, db);
    if (
      !persisted ||
      !samePublicSigningKey(persisted.signingPublicJwk, record.signingPublicJwk)
    ) {
      return persisted;
    }

    await bucket.put(accountRecordKey(record.accountId), JSON.stringify(persisted), {
      httpMetadata: { contentType: "application/json" },
    });
    return persisted;
  }

  const created = await bucket.put(accountRecordKey(record.accountId), JSON.stringify(record), {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (created) {
    return record;
  }

  return readAccountRecord(bucket, record.accountId);
};

/** Pins an account encryption recipient once without allowing a later replacement. */
export const pinAccountEncryptionRecipient = async (
  bucket: VoidBlobStore,
  record: AccountRecordV1,
  recipient: AccountEncryptionRecipient,
  db?: VoidSqlStore,
): Promise<AccountRecordV1 | null> => {
  const existingRecipient = record.encryptionKid
    ? {
        encryptionKid: record.encryptionKid,
        encryptionPublicJwk: record.encryptionPublicJwk as JsonWebKey,
      }
    : undefined;
  if (existingRecipient) {
    return sameAccountEncryptionRecipient(existingRecipient, recipient) ? record : null;
  }

  const updated = {
    ...record,
    ...recipient,
    updatedAt: Date.now(),
  };
  if (!db) {
    await bucket.put(accountRecordKey(record.accountId), JSON.stringify(updated), {
      httpMetadata: { contentType: "application/json" },
    });
    return updated;
  }

  await db
    .prepare(
      `UPDATE accounts
       SET encryption_kid = ?, encryption_public_jwk = ?, updated_at = ?
       WHERE account_id = ?
         AND encryption_kid IS NULL
         AND encryption_public_jwk IS NULL`,
    )
    .bind(
      recipient.encryptionKid,
      JSON.stringify(recipient.encryptionPublicJwk),
      updated.updatedAt,
      record.accountId,
    )
    .run();
  const persisted = await readAccountRecord(bucket, record.accountId, db);
  if (!persisted) return null;
  await bucket.put(accountRecordKey(record.accountId), JSON.stringify(persisted), {
    httpMetadata: { contentType: "application/json" },
  });
  return sameAccountEncryptionRecipient(
    persisted.encryptionKid
      ? {
          encryptionKid: persisted.encryptionKid,
          encryptionPublicJwk: persisted.encryptionPublicJwk as JsonWebKey,
        }
      : undefined,
    recipient,
  )
    ? persisted
    : null;
};

/** Verifies a signed account proof against the account public key. */
export const verifyAccountProof = async (input: {
  accountId: string;
  signingPublicJwk: JsonWebKey;
  signedAt: number;
  signature: string;
  recipient?: AccountEncryptionRecipient;
}): Promise<boolean> => {
  if (!isEcP256PublicJwk(input.signingPublicJwk)) {
    return false;
  }

  const skew = Math.abs(Date.now() - input.signedAt);
  if (skew > 5 * 60 * 1000) {
    return false;
  }

  try {
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
    const signatureBytes = fromBase64Url(input.signature);
    const message = serializeAccountProof(input.accountId, input.signedAt, input.recipient);
    return await crypto.subtle.verify(
      {
        name: "ECDSA",
        hash: "SHA-256",
      },
      key,
      signatureBytes,
      textEncoder.encode(message),
    );
  } catch {
    return false;
  }
};

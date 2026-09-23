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

const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const ENCRYPTION_KID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const hasPrivateJwkMaterial = (value: Record<string, unknown>): boolean =>
  ["d", "p", "q", "dp", "dq", "qi", "k"].some((key) => key in value);

/** Returns true for a public P-256 account signing key. */
export const isAccountSigningPublicJwk = (
  value: unknown,
): value is JsonWebKey => {
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
  Object.keys(value).every(
    (key) => key === "kty" || key === "n" || key === "e",
  );

/** Returns true when a value is a persisted account auth record. */
export const isAccountRecord = (value: unknown): value is AccountRecordV1 => {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (typeof value.accountId !== "string") return false;
  if (!isAccountSigningPublicJwk(value.signingPublicJwk)) return false;
  const hasEncryptionKid = value.encryptionKid !== undefined;
  const hasEncryptionPublicJwk = value.encryptionPublicJwk !== undefined;
  if (hasEncryptionKid !== hasEncryptionPublicJwk) return false;
  if (
    hasEncryptionKid &&
    !isAccountEncryptionRecipient({
      encryptionKid: value.encryptionKid,
      encryptionPublicJwk: value.encryptionPublicJwk,
    })
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

/** Removes optional JWK metadata before signing or persisting recipient authority. */
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

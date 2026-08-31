import {
  serializeCanonicalJson,
  type DropDetachedSignature,
} from "./types";

/** Persisted schema for an account-signed delegated device certificate. */
export const DROP_DEVICE_DELEGATION_SCHEMA =
  "nulldown.drop-device-delegation.v1" as const;
/** Persisted version for delegated device certificates. */
export const DROP_DEVICE_DELEGATION_VERSION = 1 as const;

/** Account-signed authority for a non-browser device to author account drops. */
export interface DropDeviceDelegation {
  schema: typeof DROP_DEVICE_DELEGATION_SCHEMA;
  version: typeof DROP_DEVICE_DELEGATION_VERSION;
  accountId: string;
  credentialId: string;
  delegateSigningPublicJwk: JsonWebKey;
  encryptionKid: string;
  encryptionPublicJwk: JsonWebKey;
  issuedAt: number;
  expiresAt: number;
  signature: DropDetachedSignature;
}

/** Delegation body signed by the account's pinned signing key. */
export interface DropDeviceDelegationSignable {
  schema: typeof DROP_DEVICE_DELEGATION_SCHEMA;
  version: typeof DROP_DEVICE_DELEGATION_VERSION;
  accountId: string;
  credentialId: string;
  delegateSigningPublicJwk: JsonWebKey;
  encryptionKid: string;
  encryptionPublicJwk: JsonWebKey;
  issuedAt: number;
  expiresAt: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const isBase64Url = (value: unknown): value is string =>
  isNonEmptyString(value) && BASE64_URL_PATTERN.test(value);
const hasPrivateMaterial = (value: Record<string, unknown>): boolean =>
  ["d", "p", "q", "dp", "dq", "qi", "k"].some((key) => key in value);
const DELEGATION_FIELDS = new Set([
  "schema",
  "version",
  "accountId",
  "credentialId",
  "delegateSigningPublicJwk",
  "encryptionKid",
  "encryptionPublicJwk",
  "issuedAt",
  "expiresAt",
  "signature",
]);

/** Returns true for an ECDSA P-256 public JWK without private material. */
export const isDropDelegateSigningPublicJwk = (
  value: unknown,
): value is JsonWebKey => {
  if (!isRecord(value) || hasPrivateMaterial(value)) return false;
  return (
    value.kty === "EC" &&
    value.crv === "P-256" &&
    isBase64Url(value.x) &&
    isBase64Url(value.y)
  );
};

/** Returns true for an RSA-OAEP public JWK without private material. */
export const isDropEncryptionPublicJwk = (
  value: unknown,
): value is JsonWebKey => {
  if (!isRecord(value) || hasPrivateMaterial(value)) return false;
  return value.kty === "RSA" && isBase64Url(value.n) && isBase64Url(value.e);
};

/** Returns true when a value is a detached ECDSA P-256 signature. */
export const isDropDetachedSignature = (
  value: unknown,
): value is DropDetachedSignature => {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.kid) &&
    value.alg === "ECDSA_P256_SHA256" &&
    isNonEmptyString(value.sig)
  );
};

/** Returns true when a delegated-device certificate is structurally safe to verify. */
export const isDropDeviceDelegation = (
  value: unknown,
): value is DropDeviceDelegation => {
  if (!isRecord(value)) return false;
  if (
    !Object.keys(value).every((key) => DELEGATION_FIELDS.has(key)) ||
    value.schema !== DROP_DEVICE_DELEGATION_SCHEMA ||
    value.version !== DROP_DEVICE_DELEGATION_VERSION ||
    !isNonEmptyString(value.accountId) ||
    !isNonEmptyString(value.credentialId) ||
    !isNonEmptyString(value.encryptionKid) ||
    !isFiniteNumber(value.issuedAt) ||
    !isFiniteNumber(value.expiresAt) ||
    value.expiresAt <= value.issuedAt
  ) {
    return false;
  }
  return (
    isDropDelegateSigningPublicJwk(value.delegateSigningPublicJwk) &&
    isDropEncryptionPublicJwk(value.encryptionPublicJwk) &&
    isDropDetachedSignature(value.signature)
  );
};

/** Removes the account signature from a delegated-device certificate. */
export const toDropDeviceDelegationSignable = (
  delegation: DropDeviceDelegation,
): DropDeviceDelegationSignable => ({
  schema: delegation.schema,
  version: delegation.version,
  accountId: delegation.accountId,
  credentialId: delegation.credentialId,
  delegateSigningPublicJwk: delegation.delegateSigningPublicJwk,
  encryptionKid: delegation.encryptionKid,
  encryptionPublicJwk: delegation.encryptionPublicJwk,
  issuedAt: delegation.issuedAt,
  expiresAt: delegation.expiresAt,
});

/** Serializes the exact canonical delegation body signed by the account key. */
export const serializeDropDeviceDelegationForSignature = (
  delegation: DropDeviceDelegationSignable,
): string => serializeCanonicalJson(delegation);

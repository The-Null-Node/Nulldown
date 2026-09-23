import type {
  DropDeviceDelegation,
  DropDeviceDelegationSignable,
} from "../device-delegation";
import { serializeCanonicalJson, type DropDetachedSignature } from "../types";

/** Persisted schema for a V1 account-signed delegated device certificate. */
export const DROP_DEVICE_DELEGATION_SCHEMA_V1 =
  "nulldown.drop-device-delegation.v1" as const;
/** Persisted version for V1 delegated device certificates. */
export const DROP_DEVICE_DELEGATION_VERSION_V1 = 1 as const;

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
const CANONICAL_DELEGATION_FIELDS = new Set([
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

type DropDeviceDelegationV1 = DropDeviceDelegation & {
  schema: typeof DROP_DEVICE_DELEGATION_SCHEMA_V1;
  version: typeof DROP_DEVICE_DELEGATION_VERSION_V1;
};
type DropDeviceDelegationSignableV1 = DropDeviceDelegationSignable & {
  schema: typeof DROP_DEVICE_DELEGATION_SCHEMA_V1;
  version: typeof DROP_DEVICE_DELEGATION_VERSION_V1;
};

const hasValidDropDeviceDelegationBody = (
  value: Record<string, unknown>,
  fields: ReadonlySet<string>,
): boolean => {
  if (
    !Object.keys(value).every((key) => fields.has(key)) ||
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

const isDropDeviceDelegationWire = (
  value: unknown,
): value is DropDeviceDelegationV1 => {
  if (!isRecord(value)) return false;
  if (
    value.schema !== DROP_DEVICE_DELEGATION_SCHEMA_V1 ||
    value.version !== DROP_DEVICE_DELEGATION_VERSION_V1
  ) {
    return false;
  }
  return hasValidDropDeviceDelegationBody(value, DELEGATION_FIELDS);
};

/** Decodes a persisted V1 delegation to the canonical delegation model. */
export const decodeDropDeviceDelegation = (
  value: unknown,
): DropDeviceDelegation | null => {
  if (!isDropDeviceDelegationWire(value)) return null;
  const delegation: Partial<DropDeviceDelegationV1> = { ...value };
  delete delegation.schema;
  delete delegation.version;
  return delegation as unknown as DropDeviceDelegation;
};

/** Encodes a canonical delegation body in its persisted V1 representation. */
const encodeDropDeviceDelegationSignable = (
  delegation: DropDeviceDelegationSignable,
): DropDeviceDelegationSignableV1 => ({
  schema: DROP_DEVICE_DELEGATION_SCHEMA_V1,
  version: DROP_DEVICE_DELEGATION_VERSION_V1,
  ...delegation,
});

/** Encodes a canonical delegation in its persisted V1 representation. */
export const encodeDropDeviceDelegation = (
  delegation: DropDeviceDelegation,
): DropDeviceDelegationV1 => ({
  ...encodeDropDeviceDelegationSignable(toDropDeviceDelegationSignable(delegation)),
  signature: delegation.signature,
});

/** Returns true when `value` is a structurally safe canonical delegation. */
export const isDropDeviceDelegation = (
  value: unknown,
): value is DropDeviceDelegation => {
  if (!isRecord(value)) return false;
  return hasValidDropDeviceDelegationBody(
    value,
    CANONICAL_DELEGATION_FIELDS,
  );
};

/** Removes the account signature from a canonical delegated-device certificate. */
export const toDropDeviceDelegationSignable = (
  delegation: DropDeviceDelegation,
): DropDeviceDelegationSignable => ({
  accountId: delegation.accountId,
  credentialId: delegation.credentialId,
  delegateSigningPublicJwk: delegation.delegateSigningPublicJwk,
  encryptionKid: delegation.encryptionKid,
  encryptionPublicJwk: delegation.encryptionPublicJwk,
  issuedAt: delegation.issuedAt,
  expiresAt: delegation.expiresAt,
});

/** Serializes the exact persisted V1 delegation body signed by the account key. */
export const serializeDropDeviceDelegationForSignature = (
  delegation: DropDeviceDelegationSignable,
): string => serializeCanonicalJson(encodeDropDeviceDelegationSignable(delegation));

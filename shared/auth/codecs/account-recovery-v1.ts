import type {
  AccountRecoveryPackageMetadata,
  AccountRecoveryPayload,
  EncryptedAccountRecoveryPackage,
} from "../recovery";

export const ACCOUNT_RECOVERY_PACKAGE_SCHEMA_V1 =
  "nulldown.account-recovery-package.v1" as const;
export const ACCOUNT_RECOVERY_PAYLOAD_SCHEMA_V1 =
  "nulldown.account-recovery-payload.v1" as const;

const STABLE_ID_PATTERN = /^[A-Za-z0-9._:~-]{1,160}$/u;
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const FINGERPRINT_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStableId = (value: unknown): value is string =>
  typeof value === "string" && STABLE_ID_PATTERN.test(value);

const isBase64Url = (value: unknown, minimum = 1): value is string =>
  typeof value === "string" &&
  value.length >= minimum &&
  BASE64_URL_PATTERN.test(value);

type AccountRecoveryPackageMetadataV1 = AccountRecoveryPackageMetadata & {
  schema: typeof ACCOUNT_RECOVERY_PACKAGE_SCHEMA_V1;
  version: 1;
};
type AccountRecoveryPayloadV1 = AccountRecoveryPayload & {
  schema: typeof ACCOUNT_RECOVERY_PAYLOAD_SCHEMA_V1;
  version: 1;
};

/** Decodes only server-safe V1 package metadata. */
export const decodeAccountRecoveryPackageMetadata = (
  value: unknown,
): AccountRecoveryPackageMetadata | null => {
  if (!isRecord(value) || Object.keys(value).length !== 14) return null;
  if (
    value.schema !== ACCOUNT_RECOVERY_PACKAGE_SCHEMA_V1 ||
    value.version !== 1 ||
    !isStableId(value.userId) ||
    !isStableId(value.accountId) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !isStableId(value.encryptionKid) ||
    !isStableId(value.signingKid) ||
    typeof value.signingKeyFingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(value.signingKeyFingerprint) ||
    value.kdf !== "HKDF-SHA-256" ||
    !isBase64Url(value.salt, 22) ||
    value.aead !== "A256GCM" ||
    !isBase64Url(value.iv, 16) ||
    typeof value.ciphertextDigest !== "string" ||
    !FINGERPRINT_PATTERN.test(value.ciphertextDigest) ||
    typeof value.ciphertextLength !== "number" ||
    !Number.isSafeInteger(value.ciphertextLength) ||
    value.ciphertextLength < 1 ||
    value.ciphertextLength > 64 * 1024
  ) {
    return null;
  }
  const metadata = { ...value };
  delete metadata.schema;
  delete metadata.version;
  return metadata as unknown as AccountRecoveryPackageMetadata;
};

/** Encodes canonical package metadata in its persisted V1 representation. */
export const encodeAccountRecoveryPackageMetadata = (
  metadata: AccountRecoveryPackageMetadata,
): AccountRecoveryPackageMetadataV1 => ({
  schema: ACCOUNT_RECOVERY_PACKAGE_SCHEMA_V1,
  version: 1,
  ...metadata,
});

/** Decodes a V1 upload without attempting to inspect encrypted private material. */
export const decodeEncryptedAccountRecoveryPackage = (
  value: unknown,
): EncryptedAccountRecoveryPackage | null => {
  if (!isRecord(value) || Object.keys(value).length !== 2) return null;
  const metadata = decodeAccountRecoveryPackageMetadata(value.metadata);
  if (!metadata || !isBase64Url(value.ciphertext)) return null;
  const estimatedLength = Math.floor((value.ciphertext.length * 3) / 4);
  if (Math.abs(estimatedLength - metadata.ciphertextLength) > 2) return null;
  return { metadata, ciphertext: value.ciphertext };
};

/** Encodes a canonical recovery package in its persisted V1 representation. */
export const encodeEncryptedAccountRecoveryPackage = (
  value: EncryptedAccountRecoveryPackage,
): { metadata: AccountRecoveryPackageMetadataV1; ciphertext: string } => ({
  metadata: encodeAccountRecoveryPackageMetadata(value.metadata),
  ciphertext: value.ciphertext,
});

const isRsaPublicJwk = (value: unknown): value is JsonWebKey =>
  isRecord(value) &&
  value.kty === "RSA" &&
  typeof value.n === "string" &&
  typeof value.e === "string";

const isRsaPrivateJwk = (value: unknown): value is JsonWebKey =>
  isRsaPublicJwk(value) &&
  typeof value.d === "string" &&
  typeof value.p === "string" &&
  typeof value.q === "string" &&
  typeof value.dp === "string" &&
  typeof value.dq === "string" &&
  typeof value.qi === "string";

const isEcPublicJwk = (value: unknown): value is JsonWebKey =>
  isRecord(value) &&
  value.kty === "EC" &&
  value.crv === "P-256" &&
  typeof value.x === "string" &&
  typeof value.y === "string";

const isEcPrivateJwk = (value: unknown): value is JsonWebKey =>
  isEcPublicJwk(value) && typeof value.d === "string";

/** Decodes V1 private recovery data after authenticated browser-side decryption. */
export const decodeAccountRecoveryPayload = (
  value: unknown,
): AccountRecoveryPayload | null => {
  if (!isRecord(value) || Object.keys(value).length !== 10) return null;
  if (
    value.schema !== ACCOUNT_RECOVERY_PAYLOAD_SCHEMA_V1 ||
    value.version !== 1 ||
    !isStableId(value.accountId) ||
    !isStableId(value.encryptionKid) ||
    !isStableId(value.signingKid) ||
    !isRsaPublicJwk(value.encryptionPublicJwk) ||
    !isRsaPrivateJwk(value.encryptionPrivateJwk) ||
    !isEcPublicJwk(value.signingPublicJwk) ||
    !isEcPrivateJwk(value.signingPrivateJwk) ||
    typeof value.createdAt !== "number" ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0
  ) {
    return null;
  }
  const payload = { ...value };
  delete payload.schema;
  delete payload.version;
  return payload as unknown as AccountRecoveryPayload;
};

/** Encodes canonical private recovery data in its persisted V1 representation. */
export const encodeAccountRecoveryPayload = (
  payload: AccountRecoveryPayload,
): AccountRecoveryPayloadV1 => ({
  schema: ACCOUNT_RECOVERY_PAYLOAD_SCHEMA_V1,
  version: 1,
  ...payload,
});

/** Canonical V1 additional-authenticated-data bytes for browser recovery encryption. */
export const serializeAccountRecoveryPackageAad = (
  metadata: AccountRecoveryPackageMetadata,
): string => {
  const encoded = encodeAccountRecoveryPackageMetadata(metadata);
  const parsed = decodeAccountRecoveryPackageMetadata(encoded);
  if (!parsed)
    throw new TypeError("Invalid account-recovery package metadata.");
  return [
    ACCOUNT_RECOVERY_PACKAGE_SCHEMA_V1,
    "1",
    parsed.userId,
    parsed.accountId,
    String(parsed.revision),
    parsed.encryptionKid,
    parsed.signingKid,
    parsed.signingKeyFingerprint,
    parsed.kdf,
    parsed.salt,
    parsed.aead,
    parsed.iv,
  ].join("\n");
};

/** Canonical V1 bytes signed by the pinned account key before a package upload. */
export const serializeAccountRecoveryPackage = (
  value: EncryptedAccountRecoveryPackage,
): string => {
  const encoded = encodeEncryptedAccountRecoveryPackage(value);
  const parsed = decodeEncryptedAccountRecoveryPackage(encoded);
  if (!parsed)
    throw new TypeError("Invalid encrypted account-recovery package.");
  return [
    serializeAccountRecoveryPackageAad(parsed.metadata),
    parsed.metadata.ciphertextDigest,
    String(parsed.metadata.ciphertextLength),
    parsed.ciphertext,
  ].join("\n");
};

export const ACCOUNT_RECOVERY_PACKAGE_SCHEMA_V1 =
  "nulldown.account-recovery-package.v1" as const;
export const ACCOUNT_RECOVERY_PAYLOAD_SCHEMA_V1 =
  "nulldown.account-recovery-payload.v1" as const;

const STABLE_ID_PATTERN = /^[A-Za-z0-9._:~-]{1,160}$/u;
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const FINGERPRINT_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/u;

/** Private V1 account material that exists only before encryption or after local decryption. */
export interface AccountRecoveryPayloadV1 {
  schema: typeof ACCOUNT_RECOVERY_PAYLOAD_SCHEMA_V1;
  version: 1;
  accountId: string;
  encryptionKid: string;
  signingKid: string;
  encryptionPublicJwk: JsonWebKey;
  encryptionPrivateJwk: JsonWebKey;
  signingPublicJwk: JsonWebKey;
  signingPrivateJwk: JsonWebKey;
  createdAt: number;
}

/** Server-visible authenticated metadata for one encrypted V1 recovery package. */
export interface AccountRecoveryPackageMetadataV1 {
  schema: typeof ACCOUNT_RECOVERY_PACKAGE_SCHEMA_V1;
  version: 1;
  userId: string;
  accountId: string;
  revision: number;
  encryptionKid: string;
  signingKid: string;
  signingKeyFingerprint: string;
  kdf: "HKDF-SHA-256";
  salt: string;
  aead: "A256GCM";
  iv: string;
  ciphertextDigest: string;
  ciphertextLength: number;
}

/** Upload/download representation. Ciphertext is opaque to server application code. */
export interface EncryptedAccountRecoveryPackageV1 {
  metadata: AccountRecoveryPackageMetadataV1;
  ciphertext: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStableId = (value: unknown): value is string =>
  typeof value === "string" && STABLE_ID_PATTERN.test(value);

const isBase64Url = (value: unknown, minimum = 1): value is string =>
  typeof value === "string" && value.length >= minimum && BASE64_URL_PATTERN.test(value);

/** Parses only server-safe package metadata. */
export const parseAccountRecoveryPackageMetadata = (
  value: unknown,
): AccountRecoveryPackageMetadataV1 | null => {
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
  return value as unknown as AccountRecoveryPackageMetadataV1;
};

/** Parses an upload without attempting to inspect encrypted private material. */
export const parseEncryptedAccountRecoveryPackage = (
  value: unknown,
): EncryptedAccountRecoveryPackageV1 | null => {
  if (!isRecord(value) || Object.keys(value).length !== 2) return null;
  const metadata = parseAccountRecoveryPackageMetadata(value.metadata);
  if (!metadata || !isBase64Url(value.ciphertext)) return null;
  const estimatedLength = Math.floor((value.ciphertext.length * 3) / 4);
  if (Math.abs(estimatedLength - metadata.ciphertextLength) > 2) return null;
  return { metadata, ciphertext: value.ciphertext };
};

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

/** Parses private recovery data only after authenticated browser-side decryption. */
export const parseAccountRecoveryPayload = (
  value: unknown,
): AccountRecoveryPayloadV1 | null => {
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
  return value as unknown as AccountRecoveryPayloadV1;
};

/** Canonical additional-authenticated-data bytes for browser recovery encryption. */
export const serializeAccountRecoveryPackageAad = (
  metadata: AccountRecoveryPackageMetadataV1,
): string => {
  const parsed = parseAccountRecoveryPackageMetadata(metadata);
  if (!parsed) throw new TypeError("Invalid account-recovery package metadata.");
  return [
    parsed.schema,
    String(parsed.version),
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

/** Canonical bytes signed by the pinned V1 account key before a package upload. */
export const serializeAccountRecoveryPackage = (
  value: EncryptedAccountRecoveryPackageV1,
): string => {
  const parsed = parseEncryptedAccountRecoveryPackage(value);
  if (!parsed) throw new TypeError("Invalid encrypted account-recovery package.");
  return [
    serializeAccountRecoveryPackageAad(parsed.metadata),
    parsed.metadata.ciphertextDigest,
    String(parsed.metadata.ciphertextLength),
    parsed.ciphertext,
  ].join("\n");
};

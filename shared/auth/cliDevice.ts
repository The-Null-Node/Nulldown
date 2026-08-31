import {
  isDropDeviceDelegation,
  isDropDelegateSigningPublicJwk,
  type DropDeviceDelegation,
} from "../drop/deviceDelegation";
import { serializeCanonicalJson } from "../drop/types";

export const CLI_DEVICE_SCHEMA_V1 = "nulldown.cli-device.v1" as const;
export const CLI_CREDENTIAL_KIND_V1 = "nulldown.cli-credential.v1" as const;
export const CLI_CREDENTIAL_ENVELOPE_KIND_V1 =
  "nulldown.cli-credential-envelope.v1" as const;

const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const USER_CODE_PATTERN = /^[A-Z2-9]{12}$/u;

/** Public RSA key used to encrypt the one-time CLI credential response. */
export interface CliEncryptionPublicJwk {
  kty: "RSA";
  n: string;
  e: string;
  alg?: string;
  ext?: boolean;
  key_ops?: string[];
}

/** Local delegated authoring material persisted only in the CLI auth file. */
export interface CliDeviceAuthoring {
  signingKid: string;
  signingPublicJwk: JsonWebKey;
  signingPrivateJwk: JsonWebKey;
  deviceDelegation: DropDeviceDelegation;
}

/** Request sent by a CLI before a browser approval can begin. */
export interface CliDeviceStartRequest {
  publicKey: CliEncryptionPublicJwk;
  clientName?: string;
}

/** Public information shown to the CLI operator during authorization. */
export interface CliDeviceStartResponse {
  kind: typeof CLI_DEVICE_SCHEMA_V1;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  interval: number;
}

/** Request sent by the browser after the user approves an account. */
export interface CliDeviceApprovalRequest {
  userCode: string;
  accountId: string;
}

/** Request sent by the CLI while waiting for browser approval. */
export interface CliDevicePollRequest {
  deviceCode: string;
}

/** Encrypted one-time credential returned after browser approval. */
export interface CliCredentialEnvelopeV1 {
  kind: typeof CLI_CREDENTIAL_ENVELOPE_KIND_V1;
  wrappedKey: string;
  iv: string;
  ciphertext: string;
}

/** Refreshable credential bundle decrypted only by the requesting CLI. */
export interface CliCredentialBundleV1 {
  kind: typeof CLI_CREDENTIAL_KIND_V1;
  version: 1;
  baseUrl: string;
  userId: string;
  accountId: string;
  credentialId: string;
  refreshToken: string;
  accessToken: string;
  accessExpiresAt: number;
  credentialExpiresAt: number;
  createdAt: number;
  authoring?: CliDeviceAuthoring;
}

export type CliDevicePollResponse =
  | { status: "pending"; interval: number }
  | { status: "approved"; envelope: CliCredentialEnvelopeV1 }
  | { status: "expired" };

/** Normalizes a human-entered device code before hashing or submission. */
export const normalizeCliUserCode = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\s-]/g, "").toUpperCase();
  return USER_CODE_PATTERN.test(normalized) ? normalized : null;
};

/** Formats a normalized user code for display. */
export const formatCliUserCode = (value: string): string =>
  value.replace(/(.{4})(?=.)/g, "$1-");

/** Validates the public key shape accepted by the device endpoint. */
export const isCliEncryptionPublicJwk = (
  value: unknown,
): value is CliEncryptionPublicJwk => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const key = value as Record<string, unknown>;
  return (
    key.kty === "RSA" &&
    typeof key.n === "string" &&
    BASE64_URL_PATTERN.test(key.n) &&
    typeof key.e === "string" &&
    BASE64_URL_PATTERN.test(key.e) &&
    !Object.prototype.hasOwnProperty.call(key, "d")
  );
};

const isCliSigningPrivateJwk = (value: unknown): value is JsonWebKey => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const key = value as Record<string, unknown>;
  return (
    key.kty === "EC" &&
    key.crv === "P-256" &&
    typeof key.x === "string" &&
    typeof key.y === "string" &&
    typeof key.d === "string"
  );
};

/** Returns true when local CLI authoring material matches its account delegation. */
export const isCliDeviceAuthoring = (
  value: unknown,
): value is CliDeviceAuthoring => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const authoring = value as Record<string, unknown>;
  if (
    typeof authoring.signingKid !== "string" ||
    !isDropDelegateSigningPublicJwk(authoring.signingPublicJwk) ||
    !isCliSigningPrivateJwk(authoring.signingPrivateJwk) ||
    !isDropDeviceDelegation(authoring.deviceDelegation)
  ) {
    return false;
  }
  return (
    serializeCanonicalJson(authoring.signingPublicJwk) ===
      serializeCanonicalJson(authoring.deviceDelegation.delegateSigningPublicJwk) &&
    authoring.signingPrivateJwk.x === authoring.signingPublicJwk.x &&
    authoring.signingPrivateJwk.y === authoring.signingPublicJwk.y
  );
};

/** Validates an encrypted one-time credential without decrypting it. */
export const isCliCredentialEnvelope = (
  value: unknown,
): value is CliCredentialEnvelopeV1 => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  return (
    envelope.kind === CLI_CREDENTIAL_ENVELOPE_KIND_V1 &&
    typeof envelope.wrappedKey === "string" &&
    BASE64_URL_PATTERN.test(envelope.wrappedKey) &&
    typeof envelope.iv === "string" &&
    BASE64_URL_PATTERN.test(envelope.iv) &&
    typeof envelope.ciphertext === "string" &&
    BASE64_URL_PATTERN.test(envelope.ciphertext)
  );
};

/** Validates a decrypted credential bundle before it is persisted. */
export const isCliCredentialBundle = (
  value: unknown,
): value is CliCredentialBundleV1 => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const bundle = value as Record<string, unknown>;
  if (
    bundle.kind !== CLI_CREDENTIAL_KIND_V1 ||
    bundle.version !== 1 ||
    typeof bundle.baseUrl !== "string" ||
    typeof bundle.userId !== "string" ||
    typeof bundle.accountId !== "string" ||
    typeof bundle.credentialId !== "string" ||
    typeof bundle.refreshToken !== "string" ||
    typeof bundle.accessToken !== "string" ||
    typeof bundle.accessExpiresAt !== "number" ||
    typeof bundle.credentialExpiresAt !== "number" ||
    typeof bundle.createdAt !== "number" ||
    (bundle.authoring !== undefined && !isCliDeviceAuthoring(bundle.authoring))
  ) {
    return false;
  }

  try {
    const url = new URL(bundle.baseUrl);
    if (!((url.protocol === "https:" || url.protocol === "http:") && url.pathname === "/" && !url.search && !url.hash)) {
      return false;
    }
  } catch {
    return false;
  }
  return (
    bundle.authoring === undefined ||
    (bundle.authoring.deviceDelegation.accountId === bundle.accountId &&
      bundle.authoring.deviceDelegation.credentialId === bundle.credentialId)
  );
};

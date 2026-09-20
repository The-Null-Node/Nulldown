import {
  decodeDropDeviceDelegation,
  encodeDropDeviceDelegation,
  isDropDelegateSigningPublicJwk,
} from "../../drop/codecs/device-delegation-v1";
import { serializeCanonicalJson } from "../../drop/types";
import type {
  CliCredentialBundle,
  CliCredentialEnvelope,
  CliDeviceAuthoring,
  CliDeviceStartResponse,
  CliEncryptionPublicJwk,
} from "../cliDevice";

export const CLI_DEVICE_SCHEMA_V1 = "nulldown.cli-device.v1" as const;
export const CLI_CREDENTIAL_KIND_V1 = "nulldown.cli-credential.v1" as const;
export const CLI_CREDENTIAL_ENVELOPE_KIND_V1 =
  "nulldown.cli-credential-envelope.v1" as const;

const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const USER_CODE_PATTERN = /^[A-Z2-9]{12}$/u;

export const normalizeCliUserCode = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\s-]/g, "").toUpperCase();
  return USER_CODE_PATTERN.test(normalized) ? normalized : null;
};

export const formatCliUserCode = (value: string): string =>
  value.replace(/(.{4})(?=.)/g, "$1-");

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

/** Decodes persisted V1 delegated authoring material. */
export const decodeCliDeviceAuthoring = (
  value: unknown,
): CliDeviceAuthoring | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const authoring = value as Record<string, unknown>;
  if (
    typeof authoring.signingKid !== "string" ||
    !isDropDelegateSigningPublicJwk(authoring.signingPublicJwk) ||
    !isCliSigningPrivateJwk(authoring.signingPrivateJwk)
  ) {
    return null;
  }
  const deviceDelegation = decodeDropDeviceDelegation(
    authoring.deviceDelegation,
  );
  if (!deviceDelegation) return null;
  return (
    serializeCanonicalJson(authoring.signingPublicJwk) ===
      serializeCanonicalJson(
        deviceDelegation.delegateSigningPublicJwk,
      ) &&
    authoring.signingPrivateJwk.x === authoring.signingPublicJwk.x &&
    authoring.signingPrivateJwk.y === authoring.signingPublicJwk.y
  )
    ? ({ ...authoring, deviceDelegation } as CliDeviceAuthoring)
    : null;
};

/** Returns true when `value` is persisted V1 delegated authoring material. */
export const isCliDeviceAuthoring = (
  value: unknown,
): value is CliDeviceAuthoring => decodeCliDeviceAuthoring(value) !== null;

/** Decodes an encrypted V1 one-time credential envelope. */
export const decodeCliCredentialEnvelope = (
  value: unknown,
): CliCredentialEnvelope | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (!(
    envelope.kind === CLI_CREDENTIAL_ENVELOPE_KIND_V1 &&
    typeof envelope.wrappedKey === "string" &&
    BASE64_URL_PATTERN.test(envelope.wrappedKey) &&
    typeof envelope.iv === "string" &&
    BASE64_URL_PATTERN.test(envelope.iv) &&
    typeof envelope.ciphertext === "string" &&
    BASE64_URL_PATTERN.test(envelope.ciphertext)
  )) {
    return null;
  }
  const canonical = { ...envelope };
  delete canonical.kind;
  return canonical as unknown as CliCredentialEnvelope;
};

/** Encodes a canonical one-time credential envelope in its V1 wire representation. */
export const encodeCliCredentialEnvelope = (
  envelope: CliCredentialEnvelope,
): CliCredentialEnvelope & { kind: typeof CLI_CREDENTIAL_ENVELOPE_KIND_V1 } => ({
  kind: CLI_CREDENTIAL_ENVELOPE_KIND_V1,
  ...envelope,
});

/** Decodes a persisted V1 CLI credential bundle. */
export const decodeCliCredentialBundle = (
  value: unknown,
): CliCredentialBundle | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
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
    (bundle.authoring !== undefined &&
      !decodeCliDeviceAuthoring(bundle.authoring))
  ) {
    return null;
  }

  try {
    const url = new URL(bundle.baseUrl);
    if (!(
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    )) {
      return null;
    }
  } catch {
    return null;
  }
  const authoring =
    bundle.authoring === undefined
      ? undefined
      : decodeCliDeviceAuthoring(bundle.authoring);
  if (
    authoring !== undefined &&
    (!authoring ||
      authoring.deviceDelegation.accountId !== bundle.accountId ||
      authoring.deviceDelegation.credentialId !== bundle.credentialId)
  ) {
    return null;
  }
  const canonical = { ...bundle };
  delete canonical.kind;
  delete canonical.version;
  delete canonical.authoring;
  return {
    ...canonical,
    ...(authoring === undefined ? {} : { authoring }),
  } as CliCredentialBundle;
};

/** Encodes a canonical credential bundle in its persisted V1 representation. */
export const encodeCliCredentialBundle = (
  bundle: CliCredentialBundle,
): CliCredentialBundle & {
  kind: typeof CLI_CREDENTIAL_KIND_V1;
  version: 1;
} => ({
  kind: CLI_CREDENTIAL_KIND_V1,
  version: 1,
  ...bundle,
  ...(bundle.authoring === undefined
    ? {}
    : {
        authoring: {
          ...bundle.authoring,
          deviceDelegation: encodeDropDeviceDelegation(
            bundle.authoring.deviceDelegation,
          ),
        },
      }),
});

/** Returns true when `value` is a persisted V1 encrypted credential envelope. */
export const isCliCredentialEnvelope = (
  value: unknown,
): value is CliCredentialEnvelope => decodeCliCredentialEnvelope(value) !== null;

/** Returns true when `value` is a persisted V1 credential bundle. */
export const isCliCredentialBundle = (
  value: unknown,
): value is CliCredentialBundle => decodeCliCredentialBundle(value) !== null;

/** Decodes a V1 CLI device start response. */
export const decodeCliDeviceStartResponse = (
  value: unknown,
): CliDeviceStartResponse | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  if (
    response.kind !== CLI_DEVICE_SCHEMA_V1 ||
    typeof response.deviceCode !== "string" ||
    typeof response.userCode !== "string" ||
    typeof response.verificationUri !== "string" ||
    typeof response.expiresAt !== "number" ||
    typeof response.interval !== "number"
  ) {
    return null;
  }
  const canonical = { ...response };
  delete canonical.kind;
  return canonical as unknown as CliDeviceStartResponse;
};

/** Encodes a canonical CLI device start response in its V1 wire representation. */
export const encodeCliDeviceStartResponse = (
  response: CliDeviceStartResponse,
): CliDeviceStartResponse & { kind: typeof CLI_DEVICE_SCHEMA_V1 } => ({
  kind: CLI_DEVICE_SCHEMA_V1,
  ...response,
});

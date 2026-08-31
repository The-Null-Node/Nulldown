import {
  isCliCredentialBundle,
  isCliCredentialEnvelope,
  isCliDeviceAuthoring,
  type CliCredentialBundleV1,
  type CliCredentialEnvelopeV1,
  type CliEncryptionPublicJwk,
} from "../../shared/auth/cliDevice";
import { normalizeCliCredentialBaseUrl } from "./cliCredential";
import { serializeCanonicalJson } from "../../shared/drop/types";

export {
  clearCliCredential,
  isCliCredentialForBaseUrl,
  readCliCredential,
  writeCliCredential,
} from "./cliCredential";

const textDecoder = new TextDecoder();

const toBytes = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid credential encoding.");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

/** Key material kept only for the duration of one device authorization. */
export interface CliDeviceKeyPair {
  publicKey: CliEncryptionPublicJwk;
  privateKey: JsonWebKey;
  authoring: CliAuthoringKeyPair | null;
}

/** Local ECDSA material generated for one authoring-capable CLI enrollment. */
export interface CliAuthoringKeyPair {
  signingKid: string;
  signingPublicJwk: JsonWebKey;
  signingPrivateJwk: JsonWebKey;
}

/** Generates an ephemeral RSA-OAEP key pair for one CLI authorization. */
export const generateCliDeviceKeyPair = async (
  requestAuthoring = false,
): Promise<CliDeviceKeyPair> => {
  const generated = (await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKeyPair;
  const publicKey = (await crypto.subtle.exportKey(
    "jwk",
    generated.publicKey,
  )) as CliEncryptionPublicJwk;
  const privateKey = await crypto.subtle.exportKey("jwk", generated.privateKey);
  if (!requestAuthoring) return { publicKey, privateKey, authoring: null };
  const authoringPair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const [signingPublicJwk, signingPrivateJwk] = await Promise.all([
    crypto.subtle.exportKey("jwk", authoringPair.publicKey),
    crypto.subtle.exportKey("jwk", authoringPair.privateKey),
  ]);
  return {
    publicKey,
    privateKey,
    authoring: {
      signingKid: `cli_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      signingPublicJwk,
      signingPrivateJwk,
    },
  };
};

/** Decrypts and validates the one-time credential returned by the poll endpoint. */
export const decryptCliCredentialEnvelope = async (
  envelope: CliCredentialEnvelopeV1,
  privateJwk: JsonWebKey,
  authoring: CliAuthoringKeyPair | null = null,
): Promise<CliCredentialBundleV1> => {
  if (!isCliCredentialEnvelope(envelope)) {
    throw new Error("CLI credential response is invalid.");
  }
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"],
  );
  const rawContentKey = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    toBytes(envelope.wrappedKey),
  );
  const contentKey = await crypto.subtle.importKey(
    "raw",
    rawContentKey,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toBytes(envelope.iv) },
    contentKey,
    toBytes(envelope.ciphertext),
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(plaintext));
  } catch {
    throw new Error("CLI credential response is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CLI credential response is invalid.");
  }
  const { authoring: serverAuthoring, ...bundle } = parsed as Record<string, unknown>;
  if (!isCliCredentialBundle(bundle)) throw new Error("CLI credential response is invalid.");
  if (serverAuthoring === undefined) {
    return {
      ...bundle,
      baseUrl: normalizeCliCredentialBaseUrl(bundle.baseUrl),
    };
  }
  if (!authoring || !serverAuthoring || typeof serverAuthoring !== "object") {
    throw new Error("CLI authoring credential response is invalid.");
  }
  const server = serverAuthoring as Record<string, unknown>;
  const candidate = {
    ...bundle,
    authoring: {
      signingKid: authoring.signingKid,
      signingPublicJwk: authoring.signingPublicJwk,
      signingPrivateJwk: authoring.signingPrivateJwk,
      deviceDelegation: server.deviceDelegation,
    },
  };
  if (
    server.signingPublicJwk === undefined ||
    serializeCanonicalJson(server.signingPublicJwk) !==
      serializeCanonicalJson(authoring.signingPublicJwk) ||
    !isCliDeviceAuthoring(candidate.authoring) ||
    !isCliCredentialBundle(candidate)
  ) {
    throw new Error("CLI authoring credential response is invalid.");
  }
  return {
    ...candidate,
    baseUrl: normalizeCliCredentialBaseUrl(candidate.baseUrl),
  };
};

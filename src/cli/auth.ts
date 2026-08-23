import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  isCliCredentialBundle,
  isCliCredentialEnvelope,
  type CliCredentialBundleV1,
  type CliCredentialEnvelopeV1,
  type CliEncryptionPublicJwk,
} from "../../shared/auth/cliDevice";

const textDecoder = new TextDecoder();

const toBytes = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid credential encoding.");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const canonicalBaseUrl = (value: string): string => {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("CLI auth base URL must be an origin.");
  }
  return url.origin;
};

/** Key material kept only for the duration of one device authorization. */
export interface CliDeviceKeyPair {
  publicKey: CliEncryptionPublicJwk;
  privateKey: JsonWebKey;
}

/** Generates an ephemeral RSA-OAEP key pair for one CLI authorization. */
export const generateCliDeviceKeyPair = async (): Promise<CliDeviceKeyPair> => {
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
  return { publicKey, privateKey };
};

/** Decrypts and validates the one-time credential returned by the poll endpoint. */
export const decryptCliCredentialEnvelope = async (
  envelope: CliCredentialEnvelopeV1,
  privateJwk: JsonWebKey,
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
  if (!isCliCredentialBundle(parsed)) {
    throw new Error("CLI credential response is invalid.");
  }
  return {
    ...parsed,
    baseUrl: canonicalBaseUrl(parsed.baseUrl),
  };
};

/** Reads a persisted CLI credential, returning null for missing or malformed data. */
export const readCliCredential = async (
  filePath: string,
): Promise<CliCredentialBundleV1 | null> => {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!isCliCredentialBundle(parsed)) return null;
    return { ...parsed, baseUrl: canonicalBaseUrl(parsed.baseUrl) };
  } catch {
    return null;
  }
};

/** Writes a CLI credential with private directory/file permissions and atomic replacement. */
export const writeCliCredential = async (
  filePath: string,
  credential: CliCredentialBundleV1,
): Promise<void> => {
  if (!isCliCredentialBundle(credential)) {
    throw new Error("Cannot persist an invalid CLI credential.");
  }
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(credential)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
};

/** Removes a local credential even when the remote revoke endpoint is unavailable. */
export const clearCliCredential = async (filePath: string): Promise<void> => {
  await unlink(filePath).catch(() => undefined);
};

/** Returns whether a credential belongs to the selected API origin. */
export const isCliCredentialForBaseUrl = (
  credential: CliCredentialBundleV1 | null,
  baseUrl: string,
): boolean => {
  if (!credential) return false;
  try {
    return credential.baseUrl === canonicalBaseUrl(baseUrl);
  } catch {
    return false;
  }
};

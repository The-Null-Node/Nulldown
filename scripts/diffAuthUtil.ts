import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHmac } from "node:crypto";
import {
  buildDiffSigningPayload,
  DIFF_SIGNATURE_PREFIX,
  type DiffAuthRegisterResponse,
} from "../shared/drop/diffAuth";

export interface DiffClientKeysRecord {
  version: 1;
  clientId: string;
  createdAt: number;
  encryptionPublicJwk: JsonWebKey;
  encryptionPrivateJwk: JsonWebKey;
}

export interface DiffCredentialEntry {
  version: 1;
  dropId: string;
  branchId: string;
  baseUrl: string;
  clientId: string;
  kid: string;
  secret: string;
  createdAt: number;
  expiresAt: number | null;
}

export interface DiffCredentialStore {
  version: 1;
  entries: Record<string, DiffCredentialEntry>;
}

export const DEFAULT_DIFF_AUTH_DIR = ".diff-auth";
export const DEFAULT_DIFF_KEYS_FILE = "keys.json";
export const DEFAULT_DIFF_CREDENTIALS_FILE = "credentials.json";

const textDecoder = new TextDecoder();

export const resolveDiffAuthDir = () =>
  resolve(process.cwd(), process.env.ND_DIFF_AUTH_DIR || DEFAULT_DIFF_AUTH_DIR);

export const keysFilePath = () =>
  resolve(resolveDiffAuthDir(), process.env.ND_DIFF_KEYS_FILE || DEFAULT_DIFF_KEYS_FILE);

export const credentialsFilePath = () =>
  resolve(
    resolveDiffAuthDir(),
    process.env.ND_DIFF_CREDENTIALS_FILE || DEFAULT_DIFF_CREDENTIALS_FILE,
  );

export const ensureParentDir = async (filePath: string): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
};

export const readJsonFile = async <T>(filePath: string): Promise<T | null> => {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export const writeJsonFile = async (filePath: string, value: unknown): Promise<void> => {
  await ensureParentDir(filePath);
  await writeFile(filePath, JSON.stringify(value, null, 2));
};

export const base64ToBytes = (value: string): Uint8Array =>
  new Uint8Array(Buffer.from(value, "base64"));

export const unwrapSecret = async (
  wrappedSecretBase64: string,
  privateJwk: JsonWebKey,
): Promise<string> => {
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    {
      name: "RSA-OAEP",
      hash: "SHA-256",
    },
    false,
    ["decrypt"],
  );

  const plaintext = await crypto.subtle.decrypt(
    {
      name: "RSA-OAEP",
    },
    privateKey,
    base64ToBytes(wrappedSecretBase64),
  );

  return textDecoder.decode(plaintext);
};

export const signDiffPayload = (
  secret: string,
  method: string,
  path: string,
  timestamp: string,
  body: string,
): string => {
  const payload = buildDiffSigningPayload(method, path, timestamp, body);
  const hex = createHmac("sha256", secret).update(payload).digest("hex");
  return `${DIFF_SIGNATURE_PREFIX}${hex}`;
};

export const getArgValue = (name: string): string | null => {
  const full = `--${name}`;
  const argv = process.argv.slice(2);
  const index = argv.findIndex((entry) => entry === full);
  if (index === -1) {
    return null;
  }

  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    return null;
  }

  return value;
};

export const hasArg = (name: string): boolean =>
  process.argv.slice(2).includes(`--${name}`);

export const upsertCredential = async (
  entry: DiffCredentialEntry,
): Promise<DiffCredentialStore> => {
  const filePath = credentialsFilePath();
  const current = (await readJsonFile<DiffCredentialStore>(filePath)) ?? {
    version: 1,
    entries: {},
  };

  const next: DiffCredentialStore = {
    version: 1,
    entries: {
      ...current.entries,
      [entry.dropId]: entry,
    },
  };

  await writeJsonFile(filePath, next);
  return next;
};

export const resolveBaseUrl = (): string =>
  (process.env.ND_BASE_URL || "http://localhost:8788").replace(/\/$/, "");

export const registerCredentialAndUnwrap = async (
  baseUrl: string,
  dropId: string,
  keys: DiffClientKeysRecord,
): Promise<DiffCredentialEntry> => {
  const response = await fetch(
    `${baseUrl}/api/diff-auth/register/${encodeURIComponent(dropId)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        clientId: keys.clientId,
        requesterPublicJwk: keys.encryptionPublicJwk,
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Registration failed with status ${response.status}`);
  }

  const payload = (await response.json()) as DiffAuthRegisterResponse;
  const secret = await unwrapSecret(payload.wrappedSecret, keys.encryptionPrivateJwk);

  return {
    version: 1,
    dropId: payload.dropId,
    branchId: payload.branchId,
    baseUrl,
    clientId: payload.clientId,
    kid: payload.kid,
    secret,
    createdAt: Date.now(),
    expiresAt: payload.expiresAt,
  };
};

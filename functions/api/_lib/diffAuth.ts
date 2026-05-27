import type { R2Bucket } from "@cloudflare/workers-types";

export const DIFF_AUTH_KEY_PREFIX = "__diff_auth__/";
export const DIFF_SECRET_BYTES = 32;
export const DIFF_AUTH_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const CLIENT_OR_KID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;

export interface DiffAuthCredentialRecord {
  version: 1;
  dropId: string;
  branchId: string;
  clientId: string;
  kid: string;
  secret: string;
  createdAt: number;
  expiresAt: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isString = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export const createDiffAuthCredentialKey = (
  dropId: string,
  clientId: string,
  kid: string,
) => `${DIFF_AUTH_KEY_PREFIX}${dropId}/${clientId}/${kid}.json`;

export const sanitizeDiffAuthToken = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || !CLIENT_OR_KID_PATTERN.test(trimmed)) {
    return null;
  }

  return trimmed;
};

export const generateDiffSecret = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(DIFF_SECRET_BYTES));
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

export const toBase64 = (value: ArrayBuffer): string => {
  const bytes = new Uint8Array(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
};

export const readDiffAuthCredential = async (
  bucket: R2Bucket,
  dropId: string,
  clientId: string,
  kid: string,
): Promise<DiffAuthCredentialRecord | null> => {
  const key = createDiffAuthCredentialKey(dropId, clientId, kid);
  const object = await bucket.get(key);
  if (!object) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = await object.json<unknown>();
  } catch {
    return null;
  }

  if (!isDiffAuthCredentialRecord(parsed)) {
    return null;
  }

  return parsed;
};

export const putDiffAuthCredential = async (
  bucket: R2Bucket,
  record: DiffAuthCredentialRecord,
): Promise<void> => {
  await bucket.put(
    createDiffAuthCredentialKey(record.dropId, record.clientId, record.kid),
    JSON.stringify(record),
    {
      httpMetadata: {
        contentType: "application/json",
      },
    },
  );
};

export const isDiffAuthCredentialRecord = (
  value: unknown,
): value is DiffAuthCredentialRecord => {
  if (!isRecord(value)) {
    return false;
  }

  if (value.version !== 1) {
    return false;
  }

  if (
    !isString(value.dropId) ||
    !isString(value.branchId) ||
    !isString(value.clientId) ||
    !isString(value.kid)
  ) {
    return false;
  }

  if (!isString(value.secret) || !isNumber(value.createdAt)) {
    return false;
  }

  if (
    value.expiresAt !== null &&
    value.expiresAt !== undefined &&
    !isNumber(value.expiresAt)
  ) {
    return false;
  }

  return true;
};

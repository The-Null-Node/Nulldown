import type { VoidBlobStore, VoidSqlStore } from "../../../../../src/server/ports";

/** R2 prefix for branch diff credential records. */
export const DIFF_AUTH_KEY_PREFIX = "__diff_auth__/";
/** Number of random bytes used for generated diff credentials. */
export const DIFF_SECRET_BYTES = 32;
/** Default lifetime for provider-issued diff credentials. */
export const DIFF_AUTH_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const CLIENT_OR_KID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;

/** Persisted branch-scoped credential used to sign diff transport requests. */
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

/** Builds the R2 key for a diff credential record. */
export const createDiffAuthCredentialKey = (
  dropId: string,
  clientId: string,
  kid: string,
) => `${DIFF_AUTH_KEY_PREFIX}${dropId}/${clientId}/${kid}.json`;

/** Normalizes and validates a branch diff credential token segment. */
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

/** Generates a random URL-safe secret for diff request signing. */
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

/** Encodes binary credential material as standard base64. */
export const toBase64 = (value: ArrayBuffer): string => {
  const bytes = new Uint8Array(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
};

/** Reads a persisted branch diff credential. */
export const readDiffAuthCredential = async (
  bucket: VoidBlobStore,
  dropId: string,
  clientId: string,
  kid: string,
  db?: VoidSqlStore,
): Promise<DiffAuthCredentialRecord | null> => {
  if (db) {
    const row = await db
      .prepare(
        `SELECT record_json
         FROM diff_auth_credentials
         WHERE drop_id = ? AND client_id = ? AND kid = ?`,
      )
      .bind(dropId, clientId, kid)
      .first<{ record_json: string }>();
    if (row) {
      try {
        const parsed = JSON.parse(row.record_json) as unknown;
        return isDiffAuthCredentialRecord(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
  }

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

  if (db) {
    await putDiffAuthCredential(bucket, parsed, db);
  }
  return parsed;
};

/** Stores a branch diff credential record. */
export const putDiffAuthCredential = async (
  bucket: VoidBlobStore,
  record: DiffAuthCredentialRecord,
  db?: VoidSqlStore,
): Promise<void> => {
  if (db) {
    await db
      .prepare(
        `INSERT INTO diff_auth_credentials (
           drop_id, client_id, kid, branch_id, secret, created_at, expires_at, record_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(drop_id, client_id, kid) DO UPDATE SET
           branch_id = excluded.branch_id,
           secret = excluded.secret,
           expires_at = excluded.expires_at,
           record_json = excluded.record_json`,
      )
      .bind(
        record.dropId,
        record.clientId,
        record.kid,
        record.branchId,
        record.secret,
        record.createdAt,
        record.expiresAt,
        JSON.stringify(record),
      )
      .run();
  }
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

/** Type guard for persisted branch diff credential records. */
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

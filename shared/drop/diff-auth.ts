/*
Diff auth signs a canonical request payload so browser editors and server webhooks can
prove they are allowed to append events to a branch. These helpers stay in `shared/`
because both the browser client and the Pages Function must agree on the exact bytes.
*/

export const DIFF_SIGNATURE_HEADER = "x-nulldown-signature";
export const DIFF_CLIENT_ID_HEADER = "x-nulldown-client-id";
export const DIFF_SECRET_KID_HEADER = "x-nulldown-secret-kid";
export const DIFF_TIMESTAMP_HEADER = "x-nulldown-timestamp";

export const DIFF_SIGNATURE_PREFIX = "sha256=";
export const DIFF_AUTH_DEFAULT_MAX_SKEW_MS = 5 * 60 * 1000;

export interface DiffAuthRegisterRequest {
  requesterPublicJwk: JsonWebKey;
  clientId?: string;
}

export interface DiffAuthRegisterResponse {
  dropId: string;
  branchId: string;
  clientId: string;
  kid: string;
  wrappedSecret: string;
  expiresAt: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() === value && value.length > 0;

const isBase64 = (value: unknown): value is string =>
  isNonEmptyString(value) &&
  value.length % 4 === 0 &&
  /^[A-Za-z0-9+/]*={0,2}$/u.test(value);

/** Decodes the untrusted HTTP response returned when registering a diff credential. */
export const decodeDiffAuthRegisterResponse = (
  value: unknown,
): DiffAuthRegisterResponse | null => {
  if (!isRecord(value)) return null;
  const keys = [
    "dropId",
    "branchId",
    "clientId",
    "kid",
    "wrappedSecret",
    "expiresAt",
  ];
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => key in value)
  ) {
    return null;
  }
  if (
    !isNonEmptyString(value.dropId) ||
    !isNonEmptyString(value.branchId) ||
    !isNonEmptyString(value.clientId) ||
    !isNonEmptyString(value.kid) ||
    !isBase64(value.wrappedSecret) ||
    (value.expiresAt !== null &&
      (typeof value.expiresAt !== "number" ||
        !Number.isSafeInteger(value.expiresAt) ||
        value.expiresAt < 0))
  ) {
    return null;
  }

  return {
    dropId: value.dropId,
    branchId: value.branchId,
    clientId: value.clientId,
    kid: value.kid,
    wrappedSecret: value.wrappedSecret,
    expiresAt: value.expiresAt,
  };
};

export const buildDiffSigningPayload = (
  method: string,
  path: string,
  timestamp: string,
  body: string,
): string => `${method.toUpperCase()}\n${path}\n${timestamp}\n${body}`;

/*
Timestamp freshness is the replay guard for provider-issued branch credentials. The
caller decides the skew window so local development and production can share one helper.
*/
export const isTimestampFresh = (
  timestamp: string,
  now = Date.now(),
  maxSkewMs = DIFF_AUTH_DEFAULT_MAX_SKEW_MS,
): boolean => {
  const parsed = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(parsed)) {
    return false;
  }

  return Math.abs(now - parsed) <= Math.max(0, maxSkewMs);
};

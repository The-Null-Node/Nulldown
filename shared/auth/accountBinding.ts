export const ACCOUNT_BINDING_CHALLENGE_SCHEMA_V1 =
  "nulldown.account-binding-challenge.v1" as const;
export const ACCOUNT_BINDING_OPERATION_V1 = "bind-account" as const;

const STABLE_ID_PATTERN = /^[A-Za-z0-9._:~-]{1,160}$/u;
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]{32,256}$/u;
const FINGERPRINT_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/u;

/** One-time server challenge signed by the current V1 account signing key. */
export interface AccountBindingChallengeV1 {
  schema: typeof ACCOUNT_BINDING_CHALLENGE_SCHEMA_V1;
  version: 1;
  operation: typeof ACCOUNT_BINDING_OPERATION_V1;
  challengeId: string;
  nonce: string;
  userId: string;
  accountId: string;
  origin: string;
  signingKeyFingerprint: string;
  issuedAt: number;
  expiresAt: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isHttpsOrigin = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      url.origin === value
    );
  } catch {
    return false;
  }
};

/** Parses the exact current challenge representation. */
export const parseAccountBindingChallenge = (
  value: unknown,
): AccountBindingChallengeV1 | null => {
  if (!isRecord(value)) return null;
  if (
    Object.keys(value).length !== 11 ||
    value.schema !== ACCOUNT_BINDING_CHALLENGE_SCHEMA_V1 ||
    value.version !== 1 ||
    value.operation !== ACCOUNT_BINDING_OPERATION_V1 ||
    typeof value.challengeId !== "string" ||
    !BASE64_URL_PATTERN.test(value.challengeId) ||
    typeof value.nonce !== "string" ||
    !BASE64_URL_PATTERN.test(value.nonce) ||
    typeof value.userId !== "string" ||
    !STABLE_ID_PATTERN.test(value.userId) ||
    typeof value.accountId !== "string" ||
    !STABLE_ID_PATTERN.test(value.accountId) ||
    !isHttpsOrigin(value.origin) ||
    typeof value.signingKeyFingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(value.signingKeyFingerprint) ||
    typeof value.issuedAt !== "number" ||
    !Number.isSafeInteger(value.issuedAt) ||
    typeof value.expiresAt !== "number" ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= value.issuedAt
  ) {
    return null;
  }

  return value as unknown as AccountBindingChallengeV1;
};

/** Produces domain-separated bytes signed by the already pinned V1 account key. */
export const serializeAccountBindingChallenge = (
  challenge: AccountBindingChallengeV1,
): string => {
  const parsed = parseAccountBindingChallenge(challenge);
  if (!parsed) throw new TypeError("Invalid account-binding challenge.");
  return [
    parsed.schema,
    String(parsed.version),
    parsed.operation,
    parsed.challengeId,
    parsed.nonce,
    parsed.userId,
    parsed.accountId,
    parsed.origin,
    parsed.signingKeyFingerprint,
    String(parsed.issuedAt),
    String(parsed.expiresAt),
  ].join("\n");
};

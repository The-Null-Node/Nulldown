import type {
  NulldownIdentity,
  NulldownUserPrincipal,
  NulldownUserSubject,
  NulldownUser,
} from "../subjects";

export const NULDOWN_USER_SUBJECT_VERSION_V1 = 1 as const;

const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const IDENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const hasOnlyKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const isStableId = (value: unknown, pattern: RegExp): value is string =>
  typeof value === "string" && pattern.test(value);

export const createNulldownUserSubject = (
  userId: string,
): NulldownUserSubject => {
  if (!isStableId(userId, USER_ID_PATTERN)) {
    throw new TypeError(
      "Nulldown userId must be a stable non-empty identifier.",
    );
  }

  return { userId };
};

/** Decodes a V1 user subject to the canonical subject model. */
export const decodeNulldownUserSubject = (
  value: unknown,
): NulldownUserSubject | null => {
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "userId"])) {
    return null;
  }

  if (value.version !== NULDOWN_USER_SUBJECT_VERSION_V1) return null;
  if (!isStableId(value.userId, USER_ID_PATTERN)) return null;

  return createNulldownUserSubject(value.userId);
};

/** Encodes a canonical user subject in its persisted V1 representation. */
export const encodeNulldownUserSubject = (
  subject: NulldownUserSubject,
): NulldownUserSubject & { version: 1 } => ({
  version: NULDOWN_USER_SUBJECT_VERSION_V1,
  ...subject,
});

/** Decodes a V1 user record to the canonical user model. */
export const decodeNulldownUser = (value: unknown): NulldownUser | null => {
  const subject = decodeNulldownUserSubject(value);
  return subject ? { userId: subject.userId } : null;
};

/** Encodes a canonical user record in its persisted V1 representation. */
export const encodeNulldownUser = (
  user: NulldownUser,
): NulldownUser & { version: 1 } => ({
  version: NULDOWN_USER_SUBJECT_VERSION_V1,
  ...user,
});

export const createNulldownIdentity = (
  identityId: string,
  userId: string,
): NulldownIdentity => {
  if (!isStableId(identityId, IDENTITY_ID_PATTERN)) {
    throw new TypeError(
      "Nulldown identityId must be a stable non-empty identifier.",
    );
  }
  if (!isStableId(userId, USER_ID_PATTERN)) {
    throw new TypeError(
      "Nulldown userId must be a stable non-empty identifier.",
    );
  }

  return {
    identityId,
    userId,
  };
};

/** Decodes a V1 identity relation to the canonical identity model. */
export const decodeNulldownIdentity = (
  value: unknown,
): NulldownIdentity | null => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["version", "identityId", "userId"])
  ) {
    return null;
  }

  if (value.version !== NULDOWN_USER_SUBJECT_VERSION_V1) return null;
  if (!isStableId(value.identityId, IDENTITY_ID_PATTERN)) return null;
  if (!isStableId(value.userId, USER_ID_PATTERN)) return null;

  return createNulldownIdentity(value.identityId, value.userId);
};

/** Encodes a canonical identity relation in its persisted V1 representation. */
export const encodeNulldownIdentity = (
  identity: NulldownIdentity,
): NulldownIdentity & { version: 1 } => ({
  version: NULDOWN_USER_SUBJECT_VERSION_V1,
  ...identity,
});

/** Decodes a V1 OpenAuth principal to the canonical principal model. */
export const decodeNulldownUserPrincipal = (
  value: unknown,
): NulldownUserPrincipal | null => {
  if (!isRecord(value) || !hasOnlyKeys(value, ["type", "properties"])) {
    return null;
  }
  if (value.type !== "nulldown-user") return null;
  const properties = decodeNulldownUserSubject(value.properties);
  return properties ? { type: "nulldown-user", properties } : null;
};

/** Encodes a canonical user principal in its V1 token-subject representation. */
export const encodeNulldownUserPrincipal = (
  principal: NulldownUserPrincipal,
): NulldownUserPrincipal & {
  properties: NulldownUserSubject & { version: 1 };
} => ({
  ...principal,
  properties: encodeNulldownUserSubject(principal.properties),
});

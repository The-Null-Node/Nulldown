/** Stable OpenAuth subject type for a recoverable Nulldown user. */
export const NULDOWN_USER_SUBJECT_TYPE = "nulldown-user" as const;

/** Current schema version for the recoverable-user contracts. */
export const NULDOWN_USER_SUBJECT_VERSION_V1 = 1 as const;

/** Versioned claims embedded in an OpenAuth `nulldown-user` access-token subject. */
export interface NulldownUserSubjectV1 {
  /** Subject contract version. */
  version: typeof NULDOWN_USER_SUBJECT_VERSION_V1;
  /** Stable internal Nulldown user identifier. */
  userId: string;
}

/** Normalized OpenAuth principal accepted by Nulldown application adapters. */
export interface NulldownUserPrincipalV1 {
  /** OpenAuth subject type. */
  type: typeof NULDOWN_USER_SUBJECT_TYPE;
  /** Strict v1 subject properties. */
  properties: NulldownUserSubjectV1;
}

/** Internal recoverable-user record shape for a future application-owned store. */
export interface NulldownUserV1 {
  /** Record contract version. */
  version: typeof NULDOWN_USER_SUBJECT_VERSION_V1;
  /** Stable internal Nulldown user identifier. */
  userId: string;
}

/** Internal identity-to-user relation shape for a future application-owned store. */
export interface NulldownIdentityV1 {
  /** Record contract version. */
  version: typeof NULDOWN_USER_SUBJECT_VERSION_V1;
  /** Stable opaque internal identity identifier. */
  identityId: string;
  /** Stable internal user identifier owning this identity. */
  userId: string;
}

const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const IDENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const isStableId = (value: unknown, pattern: RegExp): value is string =>
  typeof value === "string" && pattern.test(value);

/** Creates a strict v1 user subject from an application-owned user id. */
export const createNulldownUserSubject = (
  userId: string,
): NulldownUserSubjectV1 => {
  if (!isStableId(userId, USER_ID_PATTERN)) {
    throw new TypeError("Nulldown userId must be a stable non-empty identifier.");
  }

  return { version: NULDOWN_USER_SUBJECT_VERSION_V1, userId };
};

/** Parses only the exact current user-subject representation. */
export const parseNulldownUserSubject = (
  value: unknown,
): NulldownUserSubjectV1 | null => {
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "userId"])) {
    return null;
  }

  if (value.version !== NULDOWN_USER_SUBJECT_VERSION_V1) return null;
  if (!isStableId(value.userId, USER_ID_PATTERN)) return null;

  return createNulldownUserSubject(value.userId);
};

/** Creates the canonical OpenAuth principal for a Nulldown user id. */
export const createNulldownUserPrincipal = (
  userId: string,
): NulldownUserPrincipalV1 => ({
  type: NULDOWN_USER_SUBJECT_TYPE,
  properties: createNulldownUserSubject(userId),
});

/** Parses and normalizes an OpenAuth principal to Nulldown's strict v1 shape. */
export const parseNulldownUserPrincipal = (
  value: unknown,
): NulldownUserPrincipalV1 | null => {
  if (!isRecord(value) || !hasOnlyKeys(value, ["type", "properties"])) {
    return null;
  }

  if (value.type !== NULDOWN_USER_SUBJECT_TYPE) return null;

  const properties = parseNulldownUserSubject(value.properties);
  return properties
    ? { type: NULDOWN_USER_SUBJECT_TYPE, properties }
    : null;
};

/** Parses a future persisted internal user record without accepting unknown fields. */
export const parseNulldownUser = (value: unknown): NulldownUserV1 | null => {
  const subject = parseNulldownUserSubject(value);
  return subject ? { version: subject.version, userId: subject.userId } : null;
};

/** Parses a future persisted internal identity relation without provider credentials. */
export const parseNulldownIdentity = (
  value: unknown,
): NulldownIdentityV1 | null => {
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "identityId", "userId"])) {
    return null;
  }

  if (value.version !== NULDOWN_USER_SUBJECT_VERSION_V1) return null;
  if (!isStableId(value.identityId, IDENTITY_ID_PATTERN)) return null;
  if (!isStableId(value.userId, USER_ID_PATTERN)) return null;

  return {
    version: NULDOWN_USER_SUBJECT_VERSION_V1,
    identityId: value.identityId,
    userId: value.userId,
  };
};

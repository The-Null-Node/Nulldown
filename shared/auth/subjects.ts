/** Stable OpenAuth subject type for a recoverable Nulldown user. */
export const NULDOWN_USER_SUBJECT_TYPE = "nulldown-user" as const;

/** Claims embedded in an OpenAuth `nulldown-user` access-token subject. */
export interface NulldownUserSubject {
  /** Stable internal Nulldown user identifier. */
  userId: string;
}

/** Normalized OpenAuth principal accepted by Nulldown application adapters. */
export interface NulldownUserPrincipal {
  /** OpenAuth subject type. */
  type: typeof NULDOWN_USER_SUBJECT_TYPE;
  /** Strict subject properties. */
  properties: NulldownUserSubject;
}

/** Internal recoverable-user record shape for a future application-owned store. */
export interface NulldownUser {
  /** Stable internal Nulldown user identifier. */
  userId: string;
}

/** Internal identity-to-user relation shape for a future application-owned store. */
export interface NulldownIdentity {
  /** Stable opaque internal identity identifier. */
  identityId: string;
  /** Stable internal user identifier owning this identity. */
  userId: string;
}

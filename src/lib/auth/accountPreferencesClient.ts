import {
  isAccountPreferences,
  isAccountPreferenceValue,
  parseAccountPreferenceMutation,
  type AccountPreferenceField,
  type AccountPreferenceMutation,
  type AccountPreferences,
  type VersionedAccountPreference,
} from "../../../shared/auth/accountPreferences";

const PREFERENCES_PATH = "/api/account/preferences";

/** The server's authoritative field value after a failed revision precondition. */
export class AccountPreferenceConflictError extends Error {
  constructor(
    readonly current: VersionedAccountPreference<AccountPreferenceField>,
  ) {
    super("This preference changed on another device.");
  }
}

const isVersionedPreference = (
  field: AccountPreferenceField,
  value: unknown,
): value is VersionedAccountPreference<AccountPreferenceField> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const preference = value as Record<string, unknown>;
  return (
    Object.keys(preference).length === 3 &&
    isAccountPreferenceValue(field, preference.value) &&
    Number.isSafeInteger(preference.revision) &&
    (preference.revision as number) > 0 &&
    Number.isSafeInteger(preference.updatedAt) &&
    (preference.updatedAt as number) >= 0
  );
};

const isUpdateResponse = (
  value: unknown,
): value is {
  field: AccountPreferenceField;
  current: VersionedAccountPreference<AccountPreferenceField>;
} => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  return (
    typeof response.field === "string" &&
    (response.field === "theme" ||
      response.field === "typeface" ||
      response.field === "syntaxMode" ||
      response.field === "shareVisibilityDefault") &&
    isVersionedPreference(response.field, response.current)
  );
};

/** Fetches the complete bounded snapshot with cookie-backed OpenAuth authority. */
export const fetchAccountPreferences = async (): Promise<AccountPreferences> => {
  const response = await fetch(PREFERENCES_PATH, {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Failed to load account preferences.");
  const snapshot: unknown = await response.json();
  if (!isAccountPreferences(snapshot)) {
    throw new Error("The account preferences response is invalid.");
  }
  return snapshot;
};

/** Mutates one preference only when the caller has its current field revision. */
export const updateAccountPreference = async (
  mutation: AccountPreferenceMutation,
): Promise<{
  field: AccountPreferenceField;
  current: VersionedAccountPreference<AccountPreferenceField>;
}> => {
  if (!parseAccountPreferenceMutation(mutation)) {
    throw new Error("The account preference mutation is invalid.");
  }
  const response = await fetch(PREFERENCES_PATH, {
    method: "PATCH",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(mutation),
  });
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 409) {
    const current = body && typeof body === "object" ? (body as Record<string, unknown>).current : null;
    if (isUpdateResponse({ field: mutation.field, current })) {
      throw new AccountPreferenceConflictError(current as VersionedAccountPreference<AccountPreferenceField>);
    }
    throw new Error("The account preference conflict response is invalid.");
  }
  if (!response.ok || !isUpdateResponse(body) || body.field !== mutation.field) {
    throw new Error("Failed to update account preference.");
  }
  return body;
};

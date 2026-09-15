import { staticThemeIds } from "../themeCatalog";

/** Wire schema for the bounded account-owned preference snapshot. */
export const ACCOUNT_PREFERENCES_SCHEMA_V1 =
  "nulldown.account-preferences.v1" as const;

/** Wire schema for one compare-and-swap preference mutation. */
export const ACCOUNT_PREFERENCE_MUTATION_SCHEMA_V1 =
  "nulldown.account-preference-mutation.v1" as const;

export const ACCOUNT_PREFERENCE_FIELDS = [
  "theme",
  "typeface",
  "syntaxMode",
  "shareVisibilityDefault",
] as const;

export type AccountPreferenceField = (typeof ACCOUNT_PREFERENCE_FIELDS)[number];
export type AccountPreferenceTheme = "system" | (typeof staticThemeIds)[number];
export type AccountPreferenceTypeface =
  | "jetbrains-mono"
  | "geist-sans"
  | "editorial-serif";
export type AccountPreferenceSyntaxMode = "rendered" | "source";
export type AccountPreferenceShareVisibility = "private" | "unlisted" | "public";

export interface AccountPreferenceValues {
  theme: AccountPreferenceTheme;
  typeface: AccountPreferenceTypeface;
  syntaxMode: AccountPreferenceSyntaxMode;
  shareVisibilityDefault: AccountPreferenceShareVisibility;
}

/** One authoritative server value and its field-local revision. */
export interface VersionedAccountPreference<F extends AccountPreferenceField> {
  value: AccountPreferenceValues[F];
  revision: number;
  updatedAt: number;
}

/** Complete versioned account preference response. */
export interface AccountPreferences {
  schema: typeof ACCOUNT_PREFERENCES_SCHEMA_V1;
  version: 1;
  fields: { [F in AccountPreferenceField]: VersionedAccountPreference<F> };
}

/** Strict one-field update guarded by the last acknowledged field revision. */
export type AccountPreferenceMutation = {
  [F in AccountPreferenceField]: {
    schema: typeof ACCOUNT_PREFERENCE_MUTATION_SCHEMA_V1;
    version: 1;
    field: F;
    value: AccountPreferenceValues[F];
    expectedRevision: number;
  };
}[AccountPreferenceField];

const typefaceIds = new Set<AccountPreferenceTypeface>([
  "jetbrains-mono",
  "geist-sans",
  "editorial-serif",
]);
const themeIds = new Set<string>(["system", ...staticThemeIds]);

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

export const isAccountPreferenceField = (value: unknown): value is AccountPreferenceField =>
  typeof value === "string" && (ACCOUNT_PREFERENCE_FIELDS as readonly string[]).includes(value);

/** Validates one scalar against its fixed field allowlist. */
export const isAccountPreferenceValue = <F extends AccountPreferenceField>(
  field: F,
  value: unknown,
): value is AccountPreferenceValues[F] => {
  if (typeof value !== "string") return false;
  if (field === "theme") return themeIds.has(value);
  if (field === "typeface") return typefaceIds.has(value as AccountPreferenceTypeface);
  if (field === "syntaxMode") return value === "rendered" || value === "source";
  return value === "private" || value === "unlisted" || value === "public";
};

/** Creates a revision-zero snapshot for users who have not stored preferences yet. */
export const createDefaultAccountPreferences = (): AccountPreferences => ({
  schema: ACCOUNT_PREFERENCES_SCHEMA_V1,
  version: 1,
  fields: {
    theme: { value: "system", revision: 0, updatedAt: 0 },
    typeface: { value: "jetbrains-mono", revision: 0, updatedAt: 0 },
    syntaxMode: { value: "rendered", revision: 0, updatedAt: 0 },
    shareVisibilityDefault: { value: "unlisted", revision: 0, updatedAt: 0 },
  },
});

/** Parses an exact account preference mutation without accepting caller authority fields. */
export const parseAccountPreferenceMutation = (
  value: unknown,
): AccountPreferenceMutation | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const mutation = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(mutation, ["schema", "version", "field", "value", "expectedRevision"]) ||
    mutation.schema !== ACCOUNT_PREFERENCE_MUTATION_SCHEMA_V1 ||
    mutation.version !== 1 ||
    !isAccountPreferenceField(mutation.field) ||
    !Number.isSafeInteger(mutation.expectedRevision) ||
    (mutation.expectedRevision as number) < 0 ||
    !isAccountPreferenceValue(mutation.field, mutation.value)
  ) {
    return null;
  }
  return mutation as AccountPreferenceMutation;
};

/** Validates an exact account preference response before browser cache hydration. */
export const isAccountPreferences = (value: unknown): value is AccountPreferences => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(snapshot, ["schema", "version", "fields"]) ||
    snapshot.schema !== ACCOUNT_PREFERENCES_SCHEMA_V1 ||
    snapshot.version !== 1 ||
    !snapshot.fields ||
    typeof snapshot.fields !== "object" ||
    Array.isArray(snapshot.fields)
  ) {
    return false;
  }
  const fields = snapshot.fields as Record<string, unknown>;
  return (
    Object.keys(fields).length === ACCOUNT_PREFERENCE_FIELDS.length &&
    ACCOUNT_PREFERENCE_FIELDS.every((field) => {
      const entry = fields[field];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const versioned = entry as Record<string, unknown>;
      return (
        hasOnlyKeys(versioned, ["value", "revision", "updatedAt"]) &&
        isAccountPreferenceValue(field, versioned.value) &&
        Number.isSafeInteger(versioned.revision) &&
        (versioned.revision as number) >= 0 &&
        Number.isSafeInteger(versioned.updatedAt) &&
        (versioned.updatedAt as number) >= 0
      );
    })
  );
};

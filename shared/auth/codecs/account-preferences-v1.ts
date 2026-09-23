import { staticThemeIds } from "../../theme-catalog";
import type {
  AccountPreferenceField,
  AccountPreferenceMutation,
  AccountPreferenceTypeface,
  AccountPreferenceValues,
  AccountPreferences,
} from "../account-preferences";

export const ACCOUNT_PREFERENCES_SCHEMA_V1 =
  "nulldown.account-preferences.v1" as const;

export const ACCOUNT_PREFERENCE_MUTATION_SCHEMA_V1 =
  "nulldown.account-preference-mutation.v1" as const;

const accountPreferenceFieldsV1 = [
  "theme",
  "typeface",
  "syntaxMode",
  "shareVisibilityDefault",
] as const satisfies readonly AccountPreferenceField[];

const typefaceIdsV1 = new Set<AccountPreferenceTypeface>([
  "jetbrains-mono",
  "geist-sans",
  "editorial-serif",
]);
const themeIdsV1 = new Set<string>(["system", ...staticThemeIds]);

const hasOnlyKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => Object.keys(value).every((key) => keys.includes(key));

export const isAccountPreferenceField = (
  value: unknown,
): value is AccountPreferenceField =>
  typeof value === "string" &&
  (accountPreferenceFieldsV1 as readonly string[]).includes(value);

export const isAccountPreferenceValue = <F extends AccountPreferenceField>(
  field: F,
  value: unknown,
): value is AccountPreferenceValues[F] => {
  if (typeof value !== "string") return false;
  if (field === "theme") return themeIdsV1.has(value);
  if (field === "typeface") {
    return typefaceIdsV1.has(value as AccountPreferenceTypeface);
  }
  if (field === "syntaxMode") return value === "rendered" || value === "source";
  return value === "private" || value === "unlisted" || value === "public";
};

export const createDefaultAccountPreferences = (): AccountPreferences => ({
  fields: {
    theme: { value: "system", revision: 0, updatedAt: 0 },
    typeface: { value: "jetbrains-mono", revision: 0, updatedAt: 0 },
    syntaxMode: { value: "rendered", revision: 0, updatedAt: 0 },
    shareVisibilityDefault: { value: "unlisted", revision: 0, updatedAt: 0 },
  },
});

export const createAccountPreferenceMutation = <
  F extends AccountPreferenceField,
>(
  field: F,
  value: AccountPreferenceValues[F],
  expectedRevision: number,
): Extract<AccountPreferenceMutation, { field: F }> =>
  ({ field, value, expectedRevision }) as Extract<
    AccountPreferenceMutation,
    { field: F }
  >;

type AccountPreferencesV1 = AccountPreferences & {
  schema: typeof ACCOUNT_PREFERENCES_SCHEMA_V1;
  version: 1;
};
type AccountPreferenceMutationV1 = AccountPreferenceMutation & {
  schema: typeof ACCOUNT_PREFERENCE_MUTATION_SCHEMA_V1;
  version: 1;
};

/** Encodes canonical account preferences in their persisted V1 representation. */
export const encodeAccountPreferences = (
  preferences: AccountPreferences,
): AccountPreferencesV1 => ({
  schema: ACCOUNT_PREFERENCES_SCHEMA_V1,
  version: 1,
  ...preferences,
});

/** Encodes a canonical mutation in its persisted V1 representation. */
export const encodeAccountPreferenceMutation = (
  mutation: AccountPreferenceMutation,
): AccountPreferenceMutationV1 => ({
  schema: ACCOUNT_PREFERENCE_MUTATION_SCHEMA_V1,
  version: 1,
  ...mutation,
});

/** Decodes an exact persisted V1 mutation without accepting caller authority fields. */
export const decodeAccountPreferenceMutation = (
  value: unknown,
): AccountPreferenceMutation | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const mutation = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(mutation, [
      "schema",
      "version",
      "field",
      "value",
      "expectedRevision",
    ]) ||
    mutation.schema !== ACCOUNT_PREFERENCE_MUTATION_SCHEMA_V1 ||
    mutation.version !== 1 ||
    !isAccountPreferenceField(mutation.field) ||
    !Number.isSafeInteger(mutation.expectedRevision) ||
    (mutation.expectedRevision as number) < 0 ||
    !isAccountPreferenceValue(mutation.field, mutation.value)
  ) {
    return null;
  }
  const canonical = { ...mutation };
  delete canonical.schema;
  delete canonical.version;
  return canonical as AccountPreferenceMutation;
};

/** Decodes an exact persisted V1 preference response. */
export const decodeAccountPreferences = (
  value: unknown,
): AccountPreferences | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(snapshot, ["schema", "version", "fields"]) ||
    snapshot.schema !== ACCOUNT_PREFERENCES_SCHEMA_V1 ||
    snapshot.version !== 1 ||
    !snapshot.fields ||
    typeof snapshot.fields !== "object" ||
    Array.isArray(snapshot.fields)
  ) {
    return null;
  }
  const fields = snapshot.fields as Record<string, unknown>;
  return (
    Object.keys(fields).length === accountPreferenceFieldsV1.length &&
    accountPreferenceFieldsV1.every((field) => {
      const entry = fields[field];
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return false;
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
  )
    ? ({ fields } as AccountPreferences)
    : null;
};

/** Returns true when `value` is an exact persisted V1 preference response. */
export const isAccountPreferences = (
  value: unknown,
): value is AccountPreferences => decodeAccountPreferences(value) !== null;

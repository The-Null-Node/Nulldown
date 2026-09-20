import type { staticThemeIds } from "../themeCatalog";

export const ACCOUNT_PREFERENCE_FIELDS = [
  "theme",
  "typeface",
  "syntaxMode",
  "shareVisibilityDefault",
] as const;

export type AccountPreferenceField = (typeof ACCOUNT_PREFERENCE_FIELDS)[number];
export type AccountPreferenceTheme = "system" | (typeof staticThemeIds)[number];
export type AccountPreferenceTypeface =
  "jetbrains-mono" | "geist-sans" | "editorial-serif";
export type AccountPreferenceSyntaxMode = "rendered" | "source";
export type AccountPreferenceShareVisibility =
  "private" | "unlisted" | "public";

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
  fields: { [F in AccountPreferenceField]: VersionedAccountPreference<F> };
}

/** Strict one-field update guarded by the last acknowledged field revision. */
export type AccountPreferenceMutation = {
  [F in AccountPreferenceField]: {
    field: F;
    value: AccountPreferenceValues[F];
    expectedRevision: number;
  };
}[AccountPreferenceField];

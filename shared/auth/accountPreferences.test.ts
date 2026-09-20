import { describe, expect, it } from "@jest/globals";
import { staticThemeIds } from "../themeCatalog";
import {
  ACCOUNT_PREFERENCE_FIELDS,
  type AccountPreferenceField,
  type AccountPreferenceValues,
} from "./accountPreferences";
import {
  ACCOUNT_PREFERENCE_MUTATION_SCHEMA_V1,
  createAccountPreferenceMutation,
  createDefaultAccountPreferences,
  decodeAccountPreferenceMutation,
  decodeAccountPreferences,
  encodeAccountPreferenceMutation,
  encodeAccountPreferences,
  isAccountPreferenceField,
  isAccountPreferences,
  isAccountPreferenceValue,
} from "./codecs/account-preferences-v1";

const validPreferenceValues = {
  theme: ["system", ...staticThemeIds],
  typeface: ["jetbrains-mono", "geist-sans", "editorial-serif"],
  syntaxMode: ["rendered", "source"],
  shareVisibilityDefault: ["private", "unlisted", "public"],
} as const satisfies {
  [F in AccountPreferenceField]: readonly AccountPreferenceValues[F][];
};

describe("account preferences contract", () => {
  it("creates and accepts the exact default v1 snapshot fixture", () => {
    const snapshot = createDefaultAccountPreferences();

    expect(snapshot).toEqual({
      fields: {
        theme: { value: "system", revision: 0, updatedAt: 0 },
        typeface: { value: "jetbrains-mono", revision: 0, updatedAt: 0 },
        syntaxMode: { value: "rendered", revision: 0, updatedAt: 0 },
        shareVisibilityDefault: {
          value: "unlisted",
          revision: 0,
          updatedAt: 0,
        },
      },
    });
    const raw = JSON.stringify(encodeAccountPreferences(snapshot));
    expect(raw).toBe(
      '{"schema":"nulldown.account-preferences.v1","version":1,"fields":{"theme":{"value":"system","revision":0,"updatedAt":0},"typeface":{"value":"jetbrains-mono","revision":0,"updatedAt":0},"syntaxMode":{"value":"rendered","revision":0,"updatedAt":0},"shareVisibilityDefault":{"value":"unlisted","revision":0,"updatedAt":0}}}',
    );
    expect(decodeAccountPreferences(JSON.parse(raw))).toEqual(snapshot);
    expect(isAccountPreferences(JSON.parse(raw))).toBe(true);
  });

  it("keeps canonical fields and field-specific values in parity with v1", () => {
    expect(Object.keys(validPreferenceValues)).toEqual(
      ACCOUNT_PREFERENCE_FIELDS,
    );

    const allValues = [...new Set(Object.values(validPreferenceValues).flat())];
    for (const field of ACCOUNT_PREFERENCE_FIELDS) {
      expect(isAccountPreferenceField(field)).toBe(true);
      for (const value of allValues) {
        const expected = (
          validPreferenceValues[field] as readonly string[]
        ).includes(value);
        expect(isAccountPreferenceValue(field, value)).toBe(expected);
      }
    }
    expect(isAccountPreferenceField("unknown")).toBe(false);
  });

  it("creates and parses the exact mutation fixture without reconstruction", () => {
    const mutation = createAccountPreferenceMutation("theme", "system", 0);

    expect(mutation).toEqual({
      field: "theme",
      value: "system",
      expectedRevision: 0,
    });
    const encoded = encodeAccountPreferenceMutation(mutation);
    expect(encoded).toEqual({
      schema: ACCOUNT_PREFERENCE_MUTATION_SCHEMA_V1,
      version: 1,
      ...mutation,
    });
    expect(decodeAccountPreferenceMutation(encoded)).toEqual(mutation);
  });

  it("accepts only exact, bounded field mutations without adding defaults", () => {
    expect(
      decodeAccountPreferenceMutation({
        schema: ACCOUNT_PREFERENCE_MUTATION_SCHEMA_V1,
        version: 1,
        field: "theme",
        value: "untrusted-theme",
        expectedRevision: 0,
      }),
    ).toBeNull();
    expect(
      decodeAccountPreferenceMutation({
        schema: ACCOUNT_PREFERENCE_MUTATION_SCHEMA_V1,
        version: 1,
        field: "theme",
        value: "system",
        expectedRevision: 0,
        userId: "must-not-be-accepted",
      }),
    ).toBeNull();
    expect(
      decodeAccountPreferenceMutation({
        schema: ACCOUNT_PREFERENCE_MUTATION_SCHEMA_V1,
        version: 1,
        field: "theme",
        value: "system",
      }),
    ).toBeNull();
  });
});

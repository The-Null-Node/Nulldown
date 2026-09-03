import { describe, expect, it } from "@jest/globals";
import {
  ACCOUNT_PREFERENCE_MUTATION_SCHEMA_V1,
  createDefaultAccountPreferences,
  isAccountPreferences,
  parseAccountPreferenceMutation,
} from "./accountPreferences";

describe("account preferences contract", () => {
  it("accepts the complete default snapshot", () => {
    expect(isAccountPreferences(createDefaultAccountPreferences())).toBe(true);
  });

  it("accepts only exact, bounded field mutations", () => {
    expect(
      parseAccountPreferenceMutation({
        schema: ACCOUNT_PREFERENCE_MUTATION_SCHEMA_V1,
        version: 1,
        field: "theme",
        value: "system",
        expectedRevision: 0,
      }),
    ).not.toBeNull();
    expect(
      parseAccountPreferenceMutation({
        schema: ACCOUNT_PREFERENCE_MUTATION_SCHEMA_V1,
        version: 1,
        field: "theme",
        value: "untrusted-theme",
        expectedRevision: 0,
      }),
    ).toBeNull();
    expect(
      parseAccountPreferenceMutation({
        schema: ACCOUNT_PREFERENCE_MUTATION_SCHEMA_V1,
        version: 1,
        field: "theme",
        value: "system",
        expectedRevision: 0,
        userId: "must-not-be-accepted",
      }),
    ).toBeNull();
  });
});

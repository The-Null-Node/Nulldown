/** @jest-environment jsdom */

import { jest } from "@jest/globals";
import {
  ACCOUNT_PREFERENCE_MUTATION_SCHEMA_V1,
  createDefaultAccountPreferences,
} from "../../../shared/auth/accountPreferences";
import {
  AccountPreferenceConflictError,
  fetchAccountPreferences,
  updateAccountPreference,
} from "./accountPreferencesClient";

const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");

const installFetch = (fetch: typeof globalThis.fetch) => {
  Object.defineProperty(globalThis, "fetch", { value: fetch, configurable: true });
};

describe("account preferences client", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    if (originalFetch) Object.defineProperty(globalThis, "fetch", originalFetch);
  });

  it("loads only a strict bounded snapshot with same-origin cookies", async () => {
    const fetch = jest.fn<typeof globalThis.fetch>().mockResolvedValue({
      ok: true,
      json: async () => createDefaultAccountPreferences(),
    } as Response);
    installFetch(fetch);

    await expect(fetchAccountPreferences()).resolves.toEqual(createDefaultAccountPreferences());
    expect(fetch).toHaveBeenCalledWith("/api/account/preferences", {
      credentials: "same-origin",
      cache: "no-store",
    });
  });

  it("rejects unexpected snapshot fields rather than caching them", async () => {
    const snapshot = { ...createDefaultAccountPreferences(), userId: "not-accepted" };
    installFetch(
      jest.fn<typeof globalThis.fetch>().mockResolvedValue({
        ok: true,
        json: async () => snapshot,
      } as Response),
    );

    await expect(fetchAccountPreferences()).rejects.toThrow("response is invalid");
  });

  it("sends one revision-guarded field mutation and exposes conflicts", async () => {
    const mutation = {
      schema: ACCOUNT_PREFERENCE_MUTATION_SCHEMA_V1,
      version: 1 as const,
      field: "syntaxMode" as const,
      value: "source" as const,
      expectedRevision: 3,
    };
    const current = { value: "rendered", revision: 4, updatedAt: 10 };
    const fetch = jest.fn<typeof globalThis.fetch>().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "preference_revision_conflict", current }),
    } as Response);
    installFetch(fetch);

    await expect(updateAccountPreference(mutation)).rejects.toEqual(
      new AccountPreferenceConflictError(current as never),
    );
    expect(fetch).toHaveBeenCalledWith("/api/account/preferences", {
      method: "PATCH",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mutation),
    });
  });
});

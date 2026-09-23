/** @jest-environment jsdom */

import { jest } from "@jest/globals";
import {
  createAccountPreferenceMutation,
  createDefaultAccountPreferences,
  encodeAccountPreferenceMutation,
  encodeAccountPreferences,
} from "../../../shared/auth/codecs/account-preferences-v1";
import {
  AccountPreferenceConflictError,
  fetchAccountPreferences,
  updateAccountPreference,
} from "./account-preferences-client";

const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");

const installFetch = (fetch: typeof globalThis.fetch) => {
  Object.defineProperty(globalThis, "fetch", { value: fetch, configurable: true });
};

describe("account preferences client", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    if (originalFetch) Object.defineProperty(globalThis, "fetch", originalFetch);
  });

  it("decodes a strict bounded V1 snapshot into a canonical cache shape", async () => {
    const snapshot = createDefaultAccountPreferences();
    const fetch = jest.fn<typeof globalThis.fetch>().mockResolvedValue({
      ok: true,
      json: async () => encodeAccountPreferences(snapshot),
    } as Response);
    installFetch(fetch);

    const result = await fetchAccountPreferences();
    expect(result).toEqual(snapshot);
    expect(result).not.toHaveProperty("schema");
    expect(result).not.toHaveProperty("version");
    expect(fetch).toHaveBeenCalledWith("/api/account/preferences", {
      credentials: "same-origin",
      cache: "no-store",
    });
  });

  it("rejects unexpected snapshot fields rather than caching them", async () => {
    const snapshot = { ...encodeAccountPreferences(createDefaultAccountPreferences()), userId: "not-accepted" };
    installFetch(
      jest.fn<typeof globalThis.fetch>().mockResolvedValue({
        ok: true,
        json: async () => snapshot,
      } as Response),
    );

    await expect(fetchAccountPreferences()).rejects.toThrow("response is invalid");
  });

  it("sends one revision-guarded field mutation and exposes conflicts", async () => {
    const mutation = createAccountPreferenceMutation("syntaxMode", "source", 3);
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
      body: JSON.stringify(encodeAccountPreferenceMutation(mutation)),
    });
  });
});

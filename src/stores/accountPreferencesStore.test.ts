/** @jest-environment jsdom */

import { jest } from "@jest/globals";
import {
  createDefaultAccountPreferences,
  type AccountPreferenceMutation,
  type AccountPreferences,
} from "../../shared/auth/accountPreferences";

const fetchAccountPreferences = jest.fn<() => Promise<AccountPreferences>>();
const updateAccountPreference = jest.fn<
  (mutation: AccountPreferenceMutation) => Promise<unknown>
>();
class TestConflictError extends Error {
  constructor(readonly current: { value: string; revision: number; updatedAt: number }) {
    super("This preference changed on another device.");
  }
}
const readPersistedValue = jest.fn<(key: string) => Promise<unknown>>();
const writePersistedValue = jest.fn<(key: string, value: unknown) => Promise<void>>();
const themeState = {
  preferredThemeId: "system",
  typefaceId: "jetbrains-mono",
  setPreferredThemeId: jest.fn(),
  setTypefaceId: jest.fn(),
};
const dropState = {
  syntaxMode: "rendered",
  shareVisibility: "unlisted",
  setSyntaxMode: jest.fn(),
  setShareVisibility: jest.fn(),
};

jest.unstable_mockModule("../lib/auth/accountPreferencesClient", () => ({
  AccountPreferenceConflictError: TestConflictError,
  fetchAccountPreferences,
  updateAccountPreference,
}));
jest.unstable_mockModule("./drop/settings", () => ({ readPersistedValue, writePersistedValue }));
jest.unstable_mockModule("./dropStore", () => ({
  default: { getState: () => dropState },
}));
jest.unstable_mockModule("../theme/themeContext", () => ({
  useThemeStore: { getState: () => themeState },
}));

const { useAccountPreferencesStore } = await import("./accountPreferencesStore");

const setOnline = (online: boolean) => {
  Object.defineProperty(window.navigator, "onLine", { value: online, configurable: true });
};

describe("account preferences store", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setOnline(true);
    themeState.preferredThemeId = "system";
    themeState.typefaceId = "jetbrains-mono";
    dropState.syntaxMode = "rendered";
    dropState.shareVisibility = "unlisted";
    useAccountPreferencesStore.setState({
      userId: null,
      snapshot: null,
      status: {},
      message: null,
    });
  });

  it("keeps anonymous and offline edits local without enqueuing a remote mutation", async () => {
    setOnline(false);

    await useAccountPreferencesStore.getState().setPreference("syntaxMode", "source");

    expect(dropState.setSyntaxMode).toHaveBeenCalledWith("source");
    expect(updateAccountPreference).not.toHaveBeenCalled();
    expect(useAccountPreferencesStore.getState().status.syntaxMode).toBe("local");
  });

  it("uses the authoritative conflict value without altering unrelated fields", async () => {
    const snapshot = createDefaultAccountPreferences();
    snapshot.fields.syntaxMode = { value: "source", revision: 3, updatedAt: 5 };
    snapshot.fields.shareVisibilityDefault = { value: "private", revision: 7, updatedAt: 6 };
    updateAccountPreference.mockRejectedValue(
      new TestConflictError({ value: "rendered", revision: 4, updatedAt: 10 }),
    );
    useAccountPreferencesStore.setState({ userId: "user-a", snapshot });

    await useAccountPreferencesStore.getState().setPreference("syntaxMode", "source");

    expect(dropState.setSyntaxMode).toHaveBeenCalledWith("rendered");
    expect(useAccountPreferencesStore.getState().snapshot?.fields.syntaxMode).toEqual({
      value: "rendered",
      revision: 4,
      updatedAt: 10,
    });
    expect(useAccountPreferencesStore.getState().snapshot?.fields.shareVisibilityDefault).toEqual(
      snapshot.fields.shareVisibilityDefault,
    );
    expect(useAccountPreferencesStore.getState().status.syntaxMode).toBe("conflict");
  });

  it("hydrates cached preferences before attempting a signed-in refresh", async () => {
    const cached = createDefaultAccountPreferences();
    cached.fields.typeface = { value: "geist-sans", revision: 2, updatedAt: 9 };
    readPersistedValue.mockResolvedValue({ userId: "user-a", snapshot: cached });
    fetchAccountPreferences.mockRejectedValue(new Error("offline"));

    await useAccountPreferencesStore.getState().connect("user-a");

    expect(themeState.setTypefaceId).toHaveBeenCalledWith("geist-sans");
    expect(useAccountPreferencesStore.getState().snapshot).toEqual(cached);
    expect(useAccountPreferencesStore.getState().message).toContain("local preferences");
  });
});

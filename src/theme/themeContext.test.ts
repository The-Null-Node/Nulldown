/** @jest-environment jsdom */

import { jest } from "@jest/globals";

jest.unstable_mockModule("./syntaxThemes", () => ({ syntaxThemeStyles: {} }));
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: jest.fn().mockReturnValue({ matches: false }),
});

const { useThemeStore } = await import("./themeContext");

describe("theme document preview", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("keeps a document theme separate from the saved account preference", async () => {
    await useThemeStore.getState().setDocumentThemeId("system");
    await useThemeStore.getState().setPreferredThemeId("nord");

    expect(useThemeStore.getState().themeId).toBe("system");
    expect(useThemeStore.getState().preferredThemeId).toBe("nord");
    expect(useThemeStore.getState().documentThemeId).toBe("system");
    expect(window.localStorage.getItem("nulldown_theme")).toBe("nord");
  });
});

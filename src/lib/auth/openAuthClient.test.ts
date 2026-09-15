/** @jest-environment jsdom */

import { jest } from "@jest/globals";
import {
  beginOpenAuthLogin,
  getOpenAuthPrincipal,
  getOpenAuthReturnTo,
  getOpenAuthSessionState,
  logoutOpenAuth,
  OPEN_AUTH_LOGOUT_STORAGE_KEY,
  type OpenAuthBrowserLocation,
} from "./openAuthClient";

const originalFetchDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "fetch",
);

const installFetch = (fetch: jest.Mock): void => {
  Object.defineProperty(globalThis, "fetch", {
    value: fetch,
    configurable: true,
  });
};

const locationAt = (
  pathname: string,
  search = "",
  hash = "",
): OpenAuthBrowserLocation => ({
  pathname,
  search,
  hash,
  assign: jest.fn(),
});

describe("OpenAuth browser client", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    window.localStorage.clear();
    if (originalFetchDescriptor) {
      Object.defineProperty(globalThis, "fetch", originalFetchDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "fetch");
    }
  });

  it("reads only a minimal principal through the cookie-backed BFF without storage", async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ userId: "user-1", accessToken: "not-exposed" }),
    });
    const storageGetItem = jest.spyOn(Storage.prototype, "getItem");
    const storageSetItem = jest.spyOn(Storage.prototype, "setItem");
    installFetch(fetch);

    await expect(getOpenAuthPrincipal()).resolves.toEqual({ userId: "user-1" });

    expect(fetch).toHaveBeenCalledWith("/api/auth/open/principal", {
      credentials: "same-origin",
      cache: "no-store",
    });
    expect(storageGetItem).not.toHaveBeenCalled();
    expect(storageSetItem).not.toHaveBeenCalled();
  });

  it("fails closed to anonymous for failed, malformed, and unreadable principal responses", async () => {
    const failedFetch = jest.fn().mockResolvedValue({ ok: false });
    installFetch(failedFetch);
    await expect(getOpenAuthPrincipal()).resolves.toBeNull();
    await expect(getOpenAuthSessionState()).resolves.toEqual({ status: "unavailable" });

    const malformedFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ userId: 42 }),
    });
    installFetch(malformedFetch);
    await expect(getOpenAuthPrincipal()).resolves.toBeNull();

    const unreadableFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => Promise.reject(new Error("invalid JSON")),
    });
    installFetch(unreadableFetch);
    await expect(getOpenAuthPrincipal()).resolves.toBeNull();
  });

  it("navigates only to the same-origin BFF with a validated current relative path", () => {
    const location = locationAt("/editor", "?drop=abc", "#preview");

    beginOpenAuthLogin(location);

    expect(location.assign).toHaveBeenCalledWith(
      "/api/auth/open/login?returnTo=%2Feditor%3Fdrop%3Dabc%23preview",
    );
  });

  it("rejects scheme, host, protocol-relative, and backslash return paths", () => {
    for (const pathname of [
      "https://evil.test/editor",
      "//evil.test/editor",
      "/\\evil.test/editor",
      "/%2F%2Fevil.test/editor",
    ]) {
      const location = locationAt(pathname, "?next=ignored", "#ignored");
      expect(getOpenAuthReturnTo(location)).toBe("/");

      beginOpenAuthLogin(location);
      expect(location.assign).toHaveBeenLastCalledWith(
        "/api/auth/open/login?returnTo=%2F",
      );
    }
  });

  it("posts logout through the cookie-backed BFF and reports failure safely", async () => {
    const successfulFetch = jest.fn().mockResolvedValue({ ok: true });
    installFetch(successfulFetch);

    await expect(logoutOpenAuth()).resolves.toBe(true);
    expect(successfulFetch).toHaveBeenCalledWith("/api/auth/open/logout", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
    expect(window.localStorage.getItem(OPEN_AUTH_LOGOUT_STORAGE_KEY)).not.toBeNull();

    const failedFetch = jest.fn().mockRejectedValue(new Error("offline"));
    installFetch(failedFetch);
    await expect(logoutOpenAuth()).resolves.toBe(false);
  });
});

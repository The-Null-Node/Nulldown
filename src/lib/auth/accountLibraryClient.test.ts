/** @jest-environment jsdom */

import { jest } from "@jest/globals";

const getAccountAuthHeaders = jest.fn();
jest.unstable_mockModule("./accountSession", () => ({ getAccountAuthHeaders }));

const { fetchAccountLibrary } = await import("./accountLibraryClient");

const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");

const installFetch = (fetch: jest.Mock) => {
  Object.defineProperty(globalThis, "fetch", { value: fetch, configurable: true });
};

describe("fetchAccountLibrary", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    if (originalFetch) Object.defineProperty(globalThis, "fetch", originalFetch);
  });

  it("requests only the metadata endpoint with the current account bearer", async () => {
    getAccountAuthHeaders.mockResolvedValue({ Authorization: "Bearer account-token" });
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            state: "active",
            id: "drop_a",
            visibility: "private",
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        cursor: null,
      }),
    });
    installFetch(fetch);

    await expect(fetchAccountLibrary()).resolves.toEqual({
      items: [
        {
          state: "active",
          id: "drop_a",
          visibility: "private",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      cursor: null,
    });
    expect(fetch).toHaveBeenCalledWith("/api/account/library", {
      headers: { Authorization: "Bearer account-token" },
    });
  });

  it("rejects payload-bearing responses rather than hydrating encrypted content", async () => {
    getAccountAuthHeaders.mockResolvedValue({});
    installFetch(
      jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          items: [{ state: "active", id: "drop_a", content: "sealed payload" }],
          cursor: null,
        }),
      }),
    );

    await expect(fetchAccountLibrary()).rejects.toThrow("invalid response");
  });

  it("loads every opaque cursor page without reading encrypted drop payloads", async () => {
    getAccountAuthHeaders.mockResolvedValue({ Authorization: "Bearer account-token" });
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      state: "active" as const,
      id: `drop_${index}`,
      visibility: "private" as const,
      createdAt: index,
      updatedAt: index,
    }));
    const fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: firstPage, cursor: "opaque-next" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{ state: "deleted", id: "drop_older", deletedAt: 51 }],
          cursor: null,
        }),
      });
    installFetch(fetch);

    await expect(fetchAccountLibrary()).resolves.toEqual({
      items: [...firstPage, { state: "deleted", id: "drop_older", deletedAt: 51 }],
      cursor: null,
    });
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/account/library", {
      headers: { Authorization: "Bearer account-token" },
    });
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/account/library?cursor=opaque-next", {
      headers: { Authorization: "Bearer account-token" },
    });
  });

  it("rejects a repeated cursor instead of looping indefinitely", async () => {
    getAccountAuthHeaders.mockResolvedValue({});
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], cursor: "same-cursor" }),
    });
    installFetch(fetch);

    await expect(fetchAccountLibrary()).rejects.toThrow("unstable cursor");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

import { jest } from "@jest/globals";

const ACCOUNT_SESSION_STORAGE_KEY = "nulldown_account_session_v1";

interface StorageMock {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
}

const getUnlockedVault = jest.fn();

jest.unstable_mockModule("../void/vault/passkeyVault", () => ({
  getUnlockedVault,
}));

const createStorageMock = (): StorageMock => {
  const values = new Map<string, string>();

  return {
    getItem: jest.fn((key: string) => values.get(key) ?? null),
    setItem: jest.fn((key: string, value: string) => {
      values.set(key, String(value));
    }),
    removeItem: jest.fn((key: string) => {
      values.delete(key);
    }),
    clear: jest.fn(() => {
      values.clear();
    }),
  };
};

const vault = {
  accountId: "account-1",
  signingPrivateKey: { kind: "signing-private-key" } as CryptoKey,
  signingPublicJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
};

const installWindow = (sessionStorage: StorageMock) => {
  Object.defineProperty(globalThis, "window", {
    value: { sessionStorage },
    configurable: true,
  });
};

const loadAccountSession = async () => {
  jest.resetModules();
  return import("./accountSession");
};

describe("account session", () => {
  const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "window",
  );
  const originalFetchDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "fetch",
  );
  const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "crypto",
  );

  beforeEach(() => {
    getUnlockedVault.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();

    if (originalWindowDescriptor) {
      Object.defineProperty(globalThis, "window", originalWindowDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }

    if (originalFetchDescriptor) {
      Object.defineProperty(globalThis, "fetch", originalFetchDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "fetch");
    }

    if (originalCryptoDescriptor) {
      Object.defineProperty(globalThis, "crypto", originalCryptoDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "crypto");
    }
  });

  it("uses a fresh sessionStorage cache without unlocking the vault or fetching", async () => {
    const sessionStorage = createStorageMock();
    installWindow(sessionStorage);
    sessionStorage.setItem(
      ACCOUNT_SESSION_STORAGE_KEY,
      JSON.stringify({
        token: "cached-token",
        expiresAt: Date.now() + 60_000,
        accountId: vault.accountId,
      }),
    );
    Object.defineProperty(globalThis, "fetch", {
      value: jest.fn(),
      configurable: true,
    });

    const { getAccountAuthHeaders, getAccountSessionToken } =
      await loadAccountSession();

    await expect(getAccountSessionToken()).resolves.toBe("cached-token");
    await expect(getAccountAuthHeaders()).resolves.toEqual({
      Authorization: "Bearer cached-token",
    });
    expect(getUnlockedVault).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("reuses a successful session from memory", async () => {
    const sessionStorage = createStorageMock();
    installWindow(sessionStorage);
    getUnlockedVault.mockResolvedValue(vault);
    Object.defineProperty(globalThis, "crypto", {
      value: { subtle: { sign: jest.fn().mockResolvedValue(new Uint8Array([1])) } },
      configurable: true,
    });
    Object.defineProperty(globalThis, "fetch", {
      value: jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          token: "issued-token",
          expiresAt: Date.now() + 60_000,
          accountId: vault.accountId,
        }),
      }),
      configurable: true,
    });

    const { getAccountSessionToken } = await loadAccountSession();

    await expect(getAccountSessionToken()).resolves.toBe("issued-token");
    sessionStorage.clear();
    await expect(getAccountSessionToken()).resolves.toBe("issued-token");
    expect(getUnlockedVault).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent session requests", async () => {
    const sessionStorage = createStorageMock();
    installWindow(sessionStorage);
    let resolveVault: (value: typeof vault) => void = () => undefined;
    getUnlockedVault.mockImplementation(
      () => new Promise<typeof vault>((resolve) => {
        resolveVault = resolve;
      }),
    );
    Object.defineProperty(globalThis, "crypto", {
      value: { subtle: { sign: jest.fn().mockResolvedValue(new Uint8Array([1])) } },
      configurable: true,
    });
    Object.defineProperty(globalThis, "fetch", {
      value: jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          token: "issued-token",
          expiresAt: Date.now() + 60_000,
          accountId: vault.accountId,
        }),
      }),
      configurable: true,
    });

    const { getAccountSessionToken } = await loadAccountSession();
    const first = getAccountSessionToken();
    const second = getAccountSessionToken();

    expect(getUnlockedVault).toHaveBeenCalledTimes(1);
    resolveVault(vault);
    await expect(Promise.all([first, second])).resolves.toEqual([
      "issued-token",
      "issued-token",
    ]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("signs canonical account proof bytes and posts the exact session request", async () => {
    const sessionStorage = createStorageMock();
    installWindow(sessionStorage);
    const signedAt = 1_725_000_000_000;
    const sign = jest.fn().mockResolvedValue(new Uint8Array([0, 255, 4]));
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        token: "issued-token",
        expiresAt: signedAt + 60_000,
        accountId: vault.accountId,
      }),
    });
    getUnlockedVault.mockResolvedValue(vault);
    jest.spyOn(Date, "now").mockReturnValue(signedAt);
    Object.defineProperty(globalThis, "crypto", {
      value: { subtle: { sign } },
      configurable: true,
    });
    Object.defineProperty(globalThis, "fetch", {
      value: fetch,
      configurable: true,
    });

    const { getAccountSessionToken } = await loadAccountSession();

    await expect(getAccountSessionToken()).resolves.toBe("issued-token");
    expect(sign).toHaveBeenCalledWith(
      { name: "ECDSA", hash: "SHA-256" },
      vault.signingPrivateKey,
      expect.any(Uint8Array),
    );
    const signedBytes = sign.mock.calls[0]?.[2] as Uint8Array;
    expect(new TextDecoder().decode(signedBytes)).toBe(
      `nulldown-account-auth\n${vault.accountId}\n${signedAt}`,
    );
    expect(fetch).toHaveBeenCalledWith("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: vault.accountId,
        signingPublicJwk: vault.signingPublicJwk,
        signedAt,
        signature: "AP8E",
      }),
    });
  });

  it("force refreshes using the unlocked vault account", async () => {
    const sessionStorage = createStorageMock();
    installWindow(sessionStorage);
    sessionStorage.setItem(
      ACCOUNT_SESSION_STORAGE_KEY,
      JSON.stringify({
        token: "cached-token",
        expiresAt: Date.now() + 60_000,
        accountId: vault.accountId,
      }),
    );
    getUnlockedVault.mockResolvedValue(vault);
    Object.defineProperty(globalThis, "crypto", {
      value: { subtle: { sign: jest.fn().mockResolvedValue(new Uint8Array([1])) } },
      configurable: true,
    });
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        token: "refreshed-token",
        expiresAt: Date.now() + 60_000,
        accountId: vault.accountId,
      }),
    });
    Object.defineProperty(globalThis, "fetch", {
      value: fetch,
      configurable: true,
    });

    const { getAccountSessionToken } = await loadAccountSession();

    await expect(getAccountSessionToken({ forceRefresh: true })).resolves.toBe(
      "refreshed-token",
    );
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body as string)).toMatchObject({
      accountId: vault.accountId,
    });
    expect(JSON.parse(sessionStorage.getItem(ACCOUNT_SESSION_STORAGE_KEY) as string)).toMatchObject({
      accountId: vault.accountId,
      token: "refreshed-token",
    });
  });

  it("does not cache a token issued for a different account", async () => {
    const sessionStorage = createStorageMock();
    installWindow(sessionStorage);
    getUnlockedVault.mockResolvedValue(vault);
    Object.defineProperty(globalThis, "crypto", {
      value: { subtle: { sign: jest.fn().mockResolvedValue(new Uint8Array([1])) } },
      configurable: true,
    });
    Object.defineProperty(globalThis, "fetch", {
      value: jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          token: "wrong-account-token",
          expiresAt: Date.now() + 60_000,
          accountId: "other-account",
        }),
      }),
      configurable: true,
    });

    const { getAccountAuthHeaders, getAccountSessionToken } =
      await loadAccountSession();

    await expect(getAccountSessionToken()).resolves.toBeNull();
    expect(sessionStorage.getItem(ACCOUNT_SESSION_STORAGE_KEY)).toBeNull();
    await expect(getAccountAuthHeaders()).resolves.toEqual({});
    expect(getUnlockedVault).toHaveBeenCalledTimes(2);
  });

  it("returns Authorization only when a session token is available", async () => {
    const sessionStorage = createStorageMock();
    installWindow(sessionStorage);
    getUnlockedVault.mockRejectedValue(new Error("vault unavailable"));

    const { getAccountAuthHeaders } = await loadAccountSession();

    await expect(getAccountAuthHeaders()).resolves.toEqual({});
  });
});

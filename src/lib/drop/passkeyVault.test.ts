import { jest } from "@jest/globals";
import {
  PASSKEY_PROTECTION_STORAGE_KEY,
  PasskeyVault,
  createPasskeyVault,
  getUnlockedVault,
  type UnlockedVault,
} from "./passkeyVault";

interface LocalStorageMock {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
}

const createLocalStorageMock = (): LocalStorageMock => {
  const store = new Map<string, string>();

  return {
    getItem: jest.fn((key: string) => store.get(key) ?? null),
    setItem: jest.fn((key: string, value: string) => {
      store.set(key, String(value));
    }),
    removeItem: jest.fn((key: string) => {
      store.delete(key);
    }),
    clear: jest.fn(() => {
      store.clear();
    }),
  };
};

const installWindow = (localStorage: LocalStorageMock) => {
  Object.defineProperty(globalThis, "window", {
    value: {
      localStorage,
    },
    configurable: true,
  });
};

const unlockLeaseKeyForStorage = (storageKey: string) =>
  `${storageKey}_unlock_lease_v1`;

const ensureVaultUnlocked = async (
  vault: PasskeyVault,
  record: { accountId: string; passkeyCredentialId?: string },
) => {
  await (vault as unknown as {
    ensureVaultUnlocked: (value: {
      accountId: string;
      passkeyCredentialId?: string;
    }) => Promise<void>;
  }).ensureVaultUnlocked(record);
};

describe("passkey vault", () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    jest.restoreAllMocks();

    if (typeof originalWindow === "undefined") {
      Reflect.deleteProperty(globalThis, "window");
      return;
    }

    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      configurable: true,
    });
  });

  it("creates a PasskeyVault instance with createPasskeyVault", () => {
    const vault = createPasskeyVault();
    expect(vault).toBeInstanceOf(PasskeyVault);
  });

  it("delegates getUnlockedVault to the default vault instance", async () => {
    const unlockedVault: UnlockedVault = {
      accountId: "account-id",
      encryptionKid: "enc-kid",
      signingKid: "sig-kid",
      encryptionPublicJwk: {},
      signingPublicJwk: {},
      encryptionPublicKey: {} as CryptoKey,
      encryptionPrivateKey: {} as CryptoKey,
      signingPublicKey: {} as CryptoKey,
      signingPrivateKey: {} as CryptoKey,
    };

    const spy = jest
      .spyOn(PasskeyVault.prototype, "getUnlockedVault")
      .mockResolvedValue(unlockedVault);

    await expect(getUnlockedVault()).resolves.toEqual(unlockedVault);
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });

  it("skips passkey assertion when passkey protection is disabled", async () => {
    const storageKey = "vault-test-passkey-disabled";
    const localStorage = createLocalStorageMock();
    installWindow(localStorage);
    localStorage.setItem(PASSKEY_PROTECTION_STORAGE_KEY, "0");

    const record = {
      accountId: "account-1",
      passkeyCredentialId: "credential-1",
    };

    const vault = createPasskeyVault({ storageKey });
    const assertSpy = jest
      .spyOn(vault as unknown as { assertPasskey: () => Promise<void> }, "assertPasskey")
      .mockResolvedValue(undefined);

    await ensureVaultUnlocked(vault, record);
    expect(assertSpy).not.toHaveBeenCalled();
  });

  it("reuses persisted unlock lease across instances within TTL", async () => {
    const storageKey = "vault-test-lease";
    const ttlMs = 8_000;
    const localStorage = createLocalStorageMock();
    installWindow(localStorage);
    localStorage.setItem(PASSKEY_PROTECTION_STORAGE_KEY, "1");

    const nowSpy = jest
      .spyOn(Date, "now")
      .mockReturnValue(1_700_000_000_000);

    const record = {
      accountId: "account-1",
      passkeyCredentialId: "credential-1",
    };

    const firstVault = createPasskeyVault({ storageKey, unlockTtlMs: ttlMs });
    const firstAssertSpy = jest
      .spyOn(firstVault as unknown as { assertPasskey: () => Promise<void> }, "assertPasskey")
      .mockResolvedValue(undefined);

    await ensureVaultUnlocked(firstVault, record);
    expect(firstAssertSpy).toHaveBeenCalledTimes(1);

    const secondVault = createPasskeyVault({ storageKey, unlockTtlMs: ttlMs });
    const secondAssertSpy = jest
      .spyOn(secondVault as unknown as { assertPasskey: () => Promise<void> }, "assertPasskey")
      .mockResolvedValue(undefined);

    await ensureVaultUnlocked(secondVault, record);
    expect(secondAssertSpy).not.toHaveBeenCalled();

    const persistedLease = localStorage.getItem(
      unlockLeaseKeyForStorage(storageKey),
    );
    expect(persistedLease).not.toBeNull();

    nowSpy.mockRestore();
  });

  it("requires passkey assertion again after persisted lease expiry", async () => {
    const storageKey = "vault-test-expiry";
    const ttlMs = 8_000;
    const localStorage = createLocalStorageMock();
    installWindow(localStorage);
    localStorage.setItem(PASSKEY_PROTECTION_STORAGE_KEY, "1");

    const nowSpy = jest.spyOn(Date, "now");
    nowSpy.mockReturnValue(10_000);

    const record = {
      accountId: "account-1",
      passkeyCredentialId: "credential-1",
    };

    const firstVault = createPasskeyVault({ storageKey, unlockTtlMs: ttlMs });
    const firstAssertSpy = jest
      .spyOn(firstVault as unknown as { assertPasskey: () => Promise<void> }, "assertPasskey")
      .mockResolvedValue(undefined);

    await ensureVaultUnlocked(firstVault, record);
    expect(firstAssertSpy).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(10_000 + ttlMs + 1);

    const secondVault = createPasskeyVault({ storageKey, unlockTtlMs: ttlMs });
    const secondAssertSpy = jest
      .spyOn(secondVault as unknown as { assertPasskey: () => Promise<void> }, "assertPasskey")
      .mockResolvedValue(undefined);

    await ensureVaultUnlocked(secondVault, record);
    expect(secondAssertSpy).toHaveBeenCalledTimes(1);

    nowSpy.mockRestore();
  });

  it("ignores persisted lease when account ownership does not match", async () => {
    const storageKey = "vault-test-account-mismatch";
    const ttlMs = 8_000;
    const localStorage = createLocalStorageMock();
    installWindow(localStorage);
    localStorage.setItem(PASSKEY_PROTECTION_STORAGE_KEY, "1");

    const nowSpy = jest
      .spyOn(Date, "now")
      .mockReturnValue(2_000_000_000_000);

    const leaseKey = unlockLeaseKeyForStorage(storageKey);
    localStorage.setItem(
      leaseKey,
      JSON.stringify({
        version: 1,
        accountId: "other-account",
        expiresAt: Date.now() + ttlMs,
      }),
    );

    const record = {
      accountId: "account-1",
      passkeyCredentialId: "credential-1",
    };

    const vault = createPasskeyVault({ storageKey, unlockTtlMs: ttlMs });
    const assertSpy = jest
      .spyOn(vault as unknown as { assertPasskey: () => Promise<void> }, "assertPasskey")
      .mockResolvedValue(undefined);

    await ensureVaultUnlocked(vault, record);
    expect(assertSpy).toHaveBeenCalledTimes(1);

    const persistedLease = localStorage.getItem(leaseKey);
    expect(persistedLease).not.toBeNull();

    const parsedLease = JSON.parse(persistedLease as string) as {
      accountId: string;
    };
    expect(parsedLease.accountId).toBe("account-1");

    nowSpy.mockRestore();
  });
});

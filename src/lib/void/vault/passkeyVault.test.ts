import { jest } from "@jest/globals";
import { indexedDB } from "fake-indexeddb";
import { resetNulldownDatabaseForTests, setKvValue } from "../../indexedDb";
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

const installIndexedDbWindow = (localStorage: LocalStorageMock) => {
  Object.defineProperty(globalThis, "window", {
    value: {
      indexedDB,
      isSecureContext: true,
      localStorage,
      PublicKeyCredential: class {},
    },
    configurable: true,
  });
};

const installCredentials = (credentials: {
  create: () => Promise<PublicKeyCredential | null>;
  get: () => Promise<PublicKeyCredential | null>;
}) => {
  Object.defineProperty(globalThis, "navigator", {
    value: { credentials },
    configurable: true,
  });
};

let storageKeyCounter = 0;
const nextStorageKey = () =>
  `vault-idb-test-${Date.now()}-${(storageKeyCounter += 1)}`;

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
  const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );

  afterEach(async () => {
    jest.restoreAllMocks();
    await resetNulldownDatabaseForTests();

    if (typeof originalWindow === "undefined") {
      Reflect.deleteProperty(globalThis, "window");
      return;
    }

    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      configurable: true,
    });

    if (originalNavigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "navigator");
    }
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

  it("persists one generated vault identity in IndexedDB across instances without a localStorage fallback", async () => {
    const storageKey = nextStorageKey();
    const localStorage = createLocalStorageMock();
    installIndexedDbWindow(localStorage);

    const firstVault = createPasskeyVault({ storageKey });
    const first = await firstVault.getUnlockedVault();

    localStorage.setItem(
      storageKey,
      JSON.stringify({ accountId: "local-storage-account" }),
    );
    jest.clearAllMocks();

    const secondVault = createPasskeyVault({ storageKey });
    const second = await secondVault.getUnlockedVault();

    expect(second.accountId).toBe(first.accountId);
    expect(second.encryptionKid).toBe(first.encryptionKid);
    expect(second.signingKid).toBe(first.signingKid);
    expect(localStorage.getItem).not.toHaveBeenCalledWith(storageKey);
    expect(localStorage.setItem).not.toHaveBeenCalledWith(
      storageKey,
      expect.any(String),
    );
  });

  it("enrolls one passkey on the next unlock after IndexedDB protection is enabled", async () => {
    const storageKey = nextStorageKey();
    const localStorage = createLocalStorageMock();
    const create = jest.fn(async () => ({
      rawId: new Uint8Array([1, 2, 3]).buffer,
    })) as unknown as () => Promise<PublicKeyCredential | null>;
    const get = jest.fn(async () => ({})) as unknown as () => Promise<
      PublicKeyCredential | null
    >;
    installIndexedDbWindow(localStorage);
    installCredentials({ create, get });
    localStorage.setItem(PASSKEY_PROTECTION_STORAGE_KEY, "0");

    const firstVault = createPasskeyVault({ storageKey });
    const first = await firstVault.getUnlockedVault();
    expect(create).not.toHaveBeenCalled();

    await setKvValue(PASSKEY_PROTECTION_STORAGE_KEY, "1");

    const secondVault = createPasskeyVault({ storageKey });
    const second = await secondVault.getUnlockedVault();
    const thirdVault = createPasskeyVault({ storageKey });
    await thirdVault.getUnlockedVault();

    expect(create).toHaveBeenCalledTimes(1);
    expect(second.accountId).toBe(first.accountId);
    expect(second.encryptionKid).toBe(first.encryptionKid);
    expect(second.signingKid).toBe(first.signingKid);
  });

  it("uses an IndexedDB passkey preference instead of a conflicting localStorage preference", async () => {
    const storageKey = nextStorageKey();
    const localStorage = createLocalStorageMock();
    const create = jest.fn(async () => ({
      rawId: new Uint8Array([1, 2, 3]).buffer,
    })) as unknown as () => Promise<PublicKeyCredential | null>;
    const get = jest.fn(async () => ({})) as unknown as () => Promise<
      PublicKeyCredential | null
    >;
    installIndexedDbWindow(localStorage);
    installCredentials({ create, get });
    localStorage.setItem(PASSKEY_PROTECTION_STORAGE_KEY, "1");
    await setKvValue(PASSKEY_PROTECTION_STORAGE_KEY, "0");

    await createPasskeyVault({ storageKey }).getUnlockedVault();

    expect(create).not.toHaveBeenCalled();
  });
});

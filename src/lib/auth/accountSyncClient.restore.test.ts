/** @jest-environment jsdom */

import { jest } from "@jest/globals";
import {
  decodeEncryptedAccountRecoveryPackage,
  encodeEncryptedAccountRecoveryPackage,
} from "../../../shared/auth/codecs/account-recovery-v1";

const getLocalAccountSummary = jest.fn() as jest.Mock;
const getUnlockedVault = jest.fn() as jest.Mock;
const installLocalAccountRecoveryPayload = jest.fn() as jest.Mock;
const assignLocalAccountOwner = jest.fn() as jest.Mock;
const exportLocalAccountRecoveryPayload = jest.fn() as jest.Mock;
const getOpenAuthSessionState = jest.fn() as jest.Mock;
const authenticateAccountSigningKey = jest.fn() as jest.Mock;
const activateAccountSession = jest.fn() as jest.Mock;
const clearAccountSession = jest.fn() as jest.Mock;
const getAccountAuthHeaders = jest.fn() as jest.Mock;
const decryptAccountRecoveryPackage = jest.fn() as jest.Mock;
const encryptAccountRecoveryPayload = jest.fn() as jest.Mock;
const getKvValue = jest.fn() as jest.Mock;
const isIndexedDbSupported = jest.fn(() => false) as jest.Mock;

jest.unstable_mockModule("../void/vault/passkeyVault", () => ({
  assignLocalAccountOwner,
  exportLocalAccountRecoveryPayload,
  getLocalAccountSummary,
  getUnlockedVault,
  installLocalAccountRecoveryPayload,
}));
jest.unstable_mockModule("./openAuthClient", () => ({
  OPEN_AUTH_LOGOUT_STORAGE_KEY: "nulldown_openauth_logout_v1",
  getOpenAuthSessionState,
}));
jest.unstable_mockModule("./accountSession", () => ({
  activateAccountSession,
  authenticateAccountSigningKey,
  clearAccountSession,
  getAccountAuthHeaders,
}));
jest.unstable_mockModule("../void/vault/recovery/crypto", () => ({
  decryptAccountRecoveryPackage,
  encryptAccountRecoveryPayload,
}));
jest.unstable_mockModule("../indexedDb", () => ({
  getKvValue,
  isIndexedDbSupported,
}));

const { cancelAccountSyncOperations, restoreAccountSync, setupAccountSync } = await import(
  "./accountSyncClient",
);
const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
const originalTextEncoderDescriptor = Object.getOwnPropertyDescriptor(globalThis, "TextEncoder");

const recoveryPackage = {
  metadata: {
    schema: "nulldown.account-recovery-package.v1",
    version: 1,
    userId: "user-1",
    accountId: "account-1",
    revision: 1,
    encryptionKid: "enc_01",
    signingKid: "sig_01",
    signingKeyFingerprint: `sha256:${"a".repeat(43)}`,
    kdf: "HKDF-SHA-256",
    salt: "b".repeat(22),
    aead: "A256GCM",
    iv: "c".repeat(16),
    ciphertextDigest: `sha256:${"d".repeat(43)}`,
    ciphertextLength: 24,
  },
  ciphertext: "e".repeat(32),
};

const canonicalRecoveryPackage = decodeEncryptedAccountRecoveryPackage(recoveryPackage);
if (!canonicalRecoveryPackage) throw new Error("Expected valid recovery package fixture.");

const recoveredPayload = {
  accountId: "account-1",
  encryptionKid: "enc_01",
  signingKid: "sig_01",
  encryptionPublicJwk: {},
  encryptionPrivateJwk: {},
  signingPublicJwk: {},
  signingPrivateJwk: {},
  createdAt: 1,
};

describe("account sync restore ordering", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    installLocalAccountRecoveryPayload.mockReset();
    Object.defineProperty(globalThis, "crypto", {
      value: { subtle: { importKey: jest.fn().mockResolvedValue({}) } },
      configurable: true,
    });
    getLocalAccountSummary.mockResolvedValue({
      accountId: "local-account",
      ownerUserId: "user-1",
    });
    decryptAccountRecoveryPackage.mockResolvedValue(recoveredPayload);
    authenticateAccountSigningKey.mockResolvedValue({
      token: "account-token",
      expiresAt: Date.now() + 60_000,
      accountId: "account-1",
    });
    getOpenAuthSessionState.mockResolvedValue({
      status: "authenticated",
      principal: { userId: "user-1" },
    });
  });

  afterEach(() => {
    window.localStorage.clear();
    if (originalCryptoDescriptor) {
      Object.defineProperty(globalThis, "crypto", originalCryptoDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "crypto");
    }
    if (originalTextEncoderDescriptor) {
      Object.defineProperty(globalThis, "TextEncoder", originalTextEncoderDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "TextEncoder");
    }
  });

  it("does not replace the local account when package confirmation fails", async () => {
    window.localStorage.setItem(
      "nulldown_pending_recovery_v1",
      JSON.stringify({
        accountId: "account-1",
        revision: 1,
        ciphertextDigest: recoveryPackage.metadata.ciphertextDigest,
      }),
    );
    const fetch = (jest.fn() as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ package: recoveryPackage }),
      })
      .mockResolvedValueOnce({ ok: false, status: 503 });
    Object.defineProperty(globalThis, "fetch", {
      value: fetch,
      configurable: true,
    });

    await expect(
      restoreAccountSync(
        { userId: "user-1" },
        "recovery-code",
        { allowReplaceLocalAccount: true },
      ),
    ).rejects.toThrow("Account sync is unavailable");

    expect(decryptAccountRecoveryPackage).toHaveBeenCalledWith(recoveryPackage, "recovery-code");
    expect(installLocalAccountRecoveryPayload).not.toHaveBeenCalled();
    expect(clearAccountSession).not.toHaveBeenCalled();
    expect(activateAccountSession).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("nulldown_pending_recovery_v1")).not.toBeNull();
  });

  it("does not activate a session after cancellation during local commit", async () => {
    const fetch = (jest.fn() as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ package: recoveryPackage }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ package: recoveryPackage }),
      });
    Object.defineProperty(globalThis, "fetch", {
      value: fetch,
      configurable: true,
    });
    installLocalAccountRecoveryPayload.mockImplementationOnce(async () => {
      cancelAccountSyncOperations();
      return { accountId: "account-1", preservedAccountId: "local-account" };
    });

    await expect(
      restoreAccountSync(
        { userId: "user-1" },
        "recovery-code",
        { allowReplaceLocalAccount: true },
      ),
    ).resolves.toEqual({ accountId: "account-1", preservedAccountId: "local-account" });

    expect(clearAccountSession).not.toHaveBeenCalled();
    expect(activateAccountSession).not.toHaveBeenCalled();
  });

  it("encodes the canonical package as V1 before signing and uploading", async () => {
    getAccountAuthHeaders.mockResolvedValue({ Authorization: "Bearer account-token" });
    exportLocalAccountRecoveryPayload.mockResolvedValue(recoveredPayload);
    assignLocalAccountOwner.mockResolvedValue(undefined);
    getUnlockedVault.mockResolvedValue({
      accountId: "account-1",
      signingPrivateKey: {} as CryptoKey,
    });
    encryptAccountRecoveryPayload.mockResolvedValue({
      recoveryCode: "recovery-code",
      package: canonicalRecoveryPackage,
    });
    Object.defineProperty(globalThis, "crypto", {
      value: {
        subtle: {
          importKey: jest.fn().mockResolvedValue({}),
          sign: jest.fn().mockResolvedValue(Uint8Array.of(1).buffer),
        },
      },
      configurable: true,
    });
    Object.defineProperty(globalThis, "TextEncoder", {
      value: class {
        encode(): Uint8Array {
          return new Uint8Array();
        }
      },
      configurable: true,
    });
    const fetch = (jest.fn() as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ bound: true, accountId: "account-1" }),
      })
      .mockResolvedValueOnce({ ok: true, status: 201 });
    Object.defineProperty(globalThis, "fetch", {
      value: fetch,
      configurable: true,
    });

    await expect(setupAccountSync({ userId: "user-1" })).resolves.toEqual({
      recoveryCode: "recovery-code",
      accountId: "account-1",
      revision: 1,
      ciphertextDigest: recoveryPackage.metadata.ciphertextDigest,
    });

    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
      package: encodeEncryptedAccountRecoveryPackage(canonicalRecoveryPackage),
      signature: "AQ",
    });
    expect(window.localStorage.getItem("nulldown_pending_recovery_v1")).toBe(
      JSON.stringify({
        accountId: "account-1",
        revision: 1,
        ciphertextDigest: recoveryPackage.metadata.ciphertextDigest,
      }),
    );
  });
});

/** @jest-environment jsdom */

import { jest } from "@jest/globals";
import {
  confirmAccountSyncRecoveryCode,
  getAccountSyncState,
} from "./accountSyncClient";
import { setActiveVaultUser } from "../void/vault/passkeyVault";

const originalFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");

const installFetch = (value: jest.Mock): void => {
  Object.defineProperty(globalThis, "fetch", { value, configurable: true });
};

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

const localVaultRecord = (ownerUserId?: string) => ({
  version: 1,
  accountId: "account-1",
  ...(ownerUserId ? { ownerUserId } : {}),
  encryptionKid: "enc_01",
  signingKid: "sig_01",
  encryptionPublicJwk: { kty: "RSA", n: "n".repeat(342), e: "AQAB" },
  encryptionPrivateJwk: {
    kty: "RSA",
    n: "n".repeat(342),
    e: "AQAB",
    d: "d".repeat(342),
    p: "p".repeat(171),
    q: "q".repeat(171),
    dp: "a".repeat(171),
    dq: "b".repeat(171),
    qi: "c".repeat(171),
  },
  signingPublicJwk: {
    kty: "EC",
    crv: "P-256",
    x: "x".repeat(43),
    y: "y".repeat(43),
  },
  signingPrivateJwk: {
    kty: "EC",
    crv: "P-256",
    x: "x".repeat(43),
    y: "y".repeat(43),
    d: "d".repeat(43),
  },
  createdAt: 1,
  updatedAt: 1,
});

describe("account sync browser state", () => {
  afterEach(() => {
    window.localStorage.clear();
    setActiveVaultUser(null);
    jest.restoreAllMocks();
    if (originalFetchDescriptor) {
      Object.defineProperty(globalThis, "fetch", originalFetchDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "fetch");
    }
  });

  it("offers setup for an existing local V1 account when no package exists", async () => {
    window.localStorage.setItem(
      "nulldown_account_vault_v1",
      JSON.stringify(localVaultRecord()),
    );
    installFetch(jest.fn().mockResolvedValue({ ok: false, status: 404 }));

    await expect(getAccountSyncState({ userId: "user-1" })).resolves.toEqual({
      status: "setup",
      accountId: "account-1",
    });
  });

  it("offers restore on a clean browser and becomes ready when account ids match", async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ package: recoveryPackage }),
    });
    installFetch(fetch);

    await expect(getAccountSyncState({ userId: "user-1" })).resolves.toEqual({
      status: "restore",
      accountId: "account-1",
      localAccountId: null,
      package: recoveryPackage,
    });

    window.localStorage.setItem(
      "nulldown_account_vault_v1",
      JSON.stringify(localVaultRecord()),
    );
    setActiveVaultUser("user-1");
    await expect(getAccountSyncState({ userId: "user-1" })).resolves.toEqual({
      status: "ready",
      accountId: "account-1",
      revision: 1,
    });
    expect(
      JSON.parse(
        window.localStorage.getItem("nulldown_account_vault_v1") as string,
      ),
    ).toEqual(expect.objectContaining({ ownerUserId: "user-1" }));
  });

  it("requires replacement when a generated recovery code was not acknowledged", async () => {
    window.localStorage.setItem(
      "nulldown_account_vault_v1",
      JSON.stringify(localVaultRecord("user-1")),
    );
    window.localStorage.setItem(
      "nulldown_pending_recovery_v1",
      JSON.stringify({
        accountId: "account-1",
        revision: 1,
        ciphertextDigest: recoveryPackage.metadata.ciphertextDigest,
      }),
    );
    setActiveVaultUser("user-1");
    installFetch(
      jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ package: recoveryPackage }),
      }),
    );

    await expect(getAccountSyncState({ userId: "user-1" })).resolves.toEqual({
      status: "unconfirmed",
      accountId: "account-1",
      revision: 1,
    });
    await confirmAccountSyncRecoveryCode(
      "account-1",
      1,
      recoveryPackage.metadata.ciphertextDigest,
    );
    await expect(getAccountSyncState({ userId: "user-1" })).resolves.toEqual({
      status: "ready",
      accountId: "account-1",
      revision: 1,
    });
  });
});

import { jest } from "@jest/globals";
import {
  BrowserDropCrypto,
  createBrowserDropCrypto,
} from "./browserDropCrypto";
import type { DropEnvelopeV1 } from "../../../shared/drop/types";

interface MockSubtle {
  generateKey: jest.MockedFunction<(...args: any[]) => Promise<unknown>>;
  encrypt: jest.MockedFunction<(...args: any[]) => Promise<unknown>>;
  exportKey: jest.MockedFunction<(...args: any[]) => Promise<unknown>>;
  sign: jest.MockedFunction<(...args: any[]) => Promise<unknown>>;
  verify: jest.MockedFunction<(...args: any[]) => Promise<unknown>>;
  decrypt: jest.MockedFunction<(...args: any[]) => Promise<unknown>>;
  importKey: jest.MockedFunction<(...args: any[]) => Promise<unknown>>;
}

const ensureBase64Globals = () => {
  if (typeof globalThis.btoa !== "function") {
    Object.defineProperty(globalThis, "btoa", {
      value: (value: string) => Buffer.from(value, "binary").toString("base64"),
      configurable: true,
    });
  }

  if (typeof globalThis.atob !== "function") {
    Object.defineProperty(globalThis, "atob", {
      value: (value: string) => Buffer.from(value, "base64").toString("binary"),
      configurable: true,
    });
  }
};

const installMockCrypto = (): MockSubtle => {
  const subtle: MockSubtle = {
    generateKey: jest.fn() as MockSubtle["generateKey"],
    encrypt: jest.fn() as MockSubtle["encrypt"],
    exportKey: jest.fn() as MockSubtle["exportKey"],
    sign: jest.fn() as MockSubtle["sign"],
    verify: jest.fn() as MockSubtle["verify"],
    decrypt: jest.fn() as MockSubtle["decrypt"],
    importKey: jest.fn() as MockSubtle["importKey"],
  };

  Object.defineProperty(globalThis, "crypto", {
    value: {
      subtle,
      getRandomValues: (value: Uint8Array) => {
        value.fill(7);
        return value;
      },
      randomUUID: () => "mock-random-uuid",
    },
    configurable: true,
  });

  return subtle;
};

const createUnlockedVault = () => ({
  accountId: "account-1",
  encryptionKid: "enc-kid-1",
  signingKid: "sig-kid-1",
  encryptionPublicJwk: {},
  signingPublicJwk: {},
  encryptionPublicKey: {} as CryptoKey,
  encryptionPrivateKey: {} as CryptoKey,
  signingPublicKey: {} as CryptoKey,
  signingPrivateKey: {} as CryptoKey,
});

const createVaultMock = () => {
  const getUnlockedVault = jest.fn() as jest.MockedFunction<
    () => Promise<ReturnType<typeof createUnlockedVault>>
  >;
  getUnlockedVault.mockResolvedValue(createUnlockedVault());
  return {
    getUnlockedVault,
  };
};

describe("browser drop crypto", () => {
  beforeEach(() => {
    ensureBase64Globals();
  });

  it("creates BrowserDropCrypto with createBrowserDropCrypto", () => {
    const instance = createBrowserDropCrypto();
    expect(instance).toBeInstanceOf(BrowserDropCrypto);
  });

  it("seals payloads into encrypted envelopes", async () => {
    const subtle = installMockCrypto();
    subtle.generateKey.mockResolvedValue({} as CryptoKey);
    subtle.encrypt
      .mockResolvedValueOnce(Uint8Array.from([11, 12, 13]).buffer)
      .mockResolvedValueOnce(Uint8Array.from([21, 22, 23]).buffer);
    subtle.exportKey.mockResolvedValue(Uint8Array.from([31, 32, 33]).buffer);
    subtle.sign.mockResolvedValue(Uint8Array.from([41, 42, 43]).buffer);

    const vault = createVaultMock();

    const cryptoPort = new BrowserDropCrypto({
      vault: vault as any,
    });

    const envelope = await cryptoPort.seal({
      content: "Hello from test",
      metadata: { themeId: "system" },
    });

    expect(vault.getUnlockedVault).toHaveBeenCalledTimes(1);
    expect(subtle.generateKey).toHaveBeenCalledTimes(1);
    expect(subtle.encrypt).toHaveBeenCalledTimes(2);
    expect(envelope.schema).toBe("nmdn.drop.v1");
    expect(envelope.signatures.device.kid).toBe("sig-kid-1");
    expect(typeof envelope.cipher.ciphertext).toBe("string");
  });

  it("opens envelopes after signature verification", async () => {
    const subtle = installMockCrypto();
    subtle.verify.mockResolvedValue(true);
    subtle.decrypt
      .mockResolvedValueOnce(Uint8Array.from([1, 2, 3, 4]).buffer)
      .mockResolvedValueOnce(new TextEncoder().encode("opened content").buffer);
    subtle.importKey.mockResolvedValue({} as CryptoKey);

    const vault = createVaultMock();

    const cryptoPort = new BrowserDropCrypto({
      vault: vault as any,
    });

    const envelope: DropEnvelopeV1 = {
      schema: "nmdn.drop.v1",
      version: 1,
      createdAt: Date.now(),
      accountId: "account-1",
      metadata: { themeId: "system" },
      cipher: {
        alg: "A256GCM",
        iv: "AQIDBA==",
        ciphertext: "BQYHCA==",
      },
      keyEnvelope: {
        mode: "account-vault-rsa-oaep",
        kid: "enc-kid-1",
        wrappedKey: "CQoLDA==",
      },
      signatures: {
        device: {
          kid: "sig-kid-1",
          alg: "ECDSA_P256_SHA256",
          sig: "DQ4P",
        },
      },
    };

    const payload = await cryptoPort.open(envelope);

    expect(vault.getUnlockedVault).toHaveBeenCalledTimes(1);
    expect(subtle.verify).toHaveBeenCalledTimes(1);
    expect(subtle.decrypt).toHaveBeenCalledTimes(2);
    expect(payload.content).toBe("opened content");
    expect(payload.metadata?.themeId).toBe("system");
  });

  it("opens draft packs when encrypted draft data exists", async () => {
    const subtle = installMockCrypto();
    subtle.verify.mockResolvedValue(true);
    subtle.decrypt
      .mockResolvedValueOnce(Uint8Array.from([1, 2, 3, 4]).buffer)
      .mockResolvedValueOnce(new TextEncoder().encode("opened content").buffer)
      .mockResolvedValueOnce(
        new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            policy: "always",
            source: "new-drop",
            createdAt: 1700000000000,
            currentSnapshotId: 3,
            snapshots: [
              {
                snapshotId: 3,
                createdAt: 1700000000000,
                fromLength: 0,
                toLength: 5,
                ops: [
                  {
                    type: "insert",
                    start: 0,
                    end: 0,
                    text: "hello",
                  },
                ],
              },
            ],
          }),
        ).buffer,
      );
    subtle.importKey.mockResolvedValue({} as CryptoKey);

    const vault = createVaultMock();

    const cryptoPort = new BrowserDropCrypto({
      vault: vault as any,
    });

    const envelope: DropEnvelopeV1 = {
      schema: "nmdn.drop.v1",
      version: 1,
      createdAt: Date.now(),
      accountId: "account-1",
      metadata: { themeId: "system" },
      cipher: {
        alg: "A256GCM",
        iv: "AQIDBA==",
        ciphertext: "BQYHCA==",
      },
      draftCipher: {
        alg: "A256GCM",
        iv: "AQIDBA==",
        ciphertext: "CQoLDA==",
      },
      keyEnvelope: {
        mode: "account-vault-rsa-oaep",
        kid: "enc-kid-1",
        wrappedKey: "CQoLDA==",
      },
      signatures: {
        device: {
          kid: "sig-kid-1",
          alg: "ECDSA_P256_SHA256",
          sig: "DQ4P",
        },
      },
    };

    const payload = await cryptoPort.open(envelope);

    expect(payload.content).toBe("opened content");
    expect(payload.draftPack?.policy).toBe("always");
    expect(payload.draftPack?.snapshots).toHaveLength(1);
    expect(subtle.decrypt).toHaveBeenCalledTimes(3);
  });

  it("wraps raw decrypt operation errors with context", async () => {
    const subtle = installMockCrypto();
    subtle.verify.mockResolvedValue(true);

    const operationError = new Error("The operation failed");
    operationError.name = "OperationError";
    subtle.decrypt.mockRejectedValue(operationError);

    const vault = createVaultMock();

    const cryptoPort = new BrowserDropCrypto({
      vault: vault as any,
    });

    const envelope: DropEnvelopeV1 = {
      schema: "nmdn.drop.v1",
      version: 1,
      createdAt: Date.now(),
      accountId: "account-1",
      metadata: { themeId: "system" },
      cipher: {
        alg: "A256GCM",
        iv: "AQIDBA==",
        ciphertext: "BQYHCA==",
      },
      keyEnvelope: {
        mode: "account-vault-rsa-oaep",
        kid: "enc-kid-1",
        wrappedKey: "CQoLDA==",
      },
      signatures: {
        device: {
          kid: "sig-kid-1",
          alg: "ECDSA_P256_SHA256",
          sig: "DQ4P",
        },
      },
    };

    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      cryptoPort.open(envelope, {
        dropId: "abc123",
      }),
    ).rejects.toThrow('Unable to decrypt drop "abc123" with the current vault');

    errorSpy.mockRestore();
  });

  it("rejects provider-signed envelopes without configured provider key", async () => {
    const subtle = installMockCrypto();
    subtle.verify.mockResolvedValue(true);

    const vault = createVaultMock();

    const cryptoPort = new BrowserDropCrypto({
      vault: vault as any,
    });

    const envelope: DropEnvelopeV1 = {
      schema: "nmdn.drop.v1",
      version: 1,
      createdAt: Date.now(),
      accountId: "account-1",
      metadata: { themeId: "system" },
      cipher: {
        alg: "A256GCM",
        iv: "AQIDBA==",
        ciphertext: "BQYHCA==",
      },
      keyEnvelope: {
        mode: "account-vault-rsa-oaep",
        kid: "enc-kid-1",
        wrappedKey: "CQoLDA==",
      },
      signatures: {
        device: {
          kid: "sig-kid-1",
          alg: "ECDSA_P256_SHA256",
          sig: "DQ4P",
        },
        provider: {
          kid: "provider-kid",
          alg: "ECDSA_P256_SHA256",
          sig: "AQI=",
        },
      },
    };

    await expect(cryptoPort.open(envelope)).rejects.toThrow(
      "Provider signature exists but no provider verify key is configured.",
    );
  });
});

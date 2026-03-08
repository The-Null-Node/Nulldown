import { jest } from "@jest/globals";
import {
  BrowserDropCrypto,
  createBrowserDropCrypto,
} from "./browserDropCrypto";
import type { DropEnvelopeV1 } from "../../../shared/drop/types";

interface MockSubtle {
  generateKey: jest.Mock;
  encrypt: jest.Mock;
  exportKey: jest.Mock;
  sign: jest.Mock;
  verify: jest.Mock;
  decrypt: jest.Mock;
  importKey: jest.Mock;
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
    generateKey: jest.fn(),
    encrypt: jest.fn(),
    exportKey: jest.fn(),
    sign: jest.fn(),
    verify: jest.fn(),
    decrypt: jest.fn(),
    importKey: jest.fn(),
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
  encryptionPublicKey: {} as CryptoKey,
  encryptionPrivateKey: {} as CryptoKey,
  signingPublicKey: {} as CryptoKey,
  signingPrivateKey: {} as CryptoKey,
});

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

    const vault = {
      getUnlockedVault: jest.fn().mockResolvedValue(createUnlockedVault()),
    };

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

    const vault = {
      getUnlockedVault: jest.fn().mockResolvedValue(createUnlockedVault()),
    };

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

  it("rejects provider-signed envelopes without configured provider key", async () => {
    const subtle = installMockCrypto();
    subtle.verify.mockResolvedValue(true);

    const vault = {
      getUnlockedVault: jest.fn().mockResolvedValue(createUnlockedVault()),
    };

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

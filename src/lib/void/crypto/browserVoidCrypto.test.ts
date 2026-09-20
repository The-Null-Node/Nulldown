import { webcrypto } from "node:crypto";
import { jest } from "@jest/globals";
import {
  BrowserVoidCrypto,
  createBrowserVoidCrypto,
} from "./browserVoidCrypto";
import {
  decodeDropEnvelope,
  encodeDropEnvelope,
  serializeDropEnvelopeForDeviceSignature,
  serializeDropEnvelopeForProviderSignature,
  toDropEnvelopeSignable,
} from "../../../../shared/drop/codecs/envelopeV1";
import type { DropEnvelope } from "../../../../shared/drop/types";


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

const createEscrowEnvelope = (): DropEnvelope => ({
  createdAt: Date.now(),
  accountId: "account-1",
  visibility: "private",
  unlockPolicy: "provider-escrow",
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
  providerEscrow: {
    mode: "provider-rsa-oaep",
    kid: "provider",
    wrappedKey: "AQIDBA==",
  },
  signatures: {
    device: {
      kid: "sig-kid-1",
      alg: "ECDSA_P256_SHA256",
      sig: "DQ4P",
    },
  },
});

describe("browser void crypto", () => {
  beforeEach(() => {
    ensureBase64Globals();
  });

  it("creates BrowserVoidCrypto with createBrowserVoidCrypto", () => {
    const instance = createBrowserVoidCrypto();
    expect(instance).toBeInstanceOf(BrowserVoidCrypto);
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

    const cryptoPort = new BrowserVoidCrypto({
      vault: vault as any,
    });

    const envelope = await cryptoPort.seal({
      content: "Hello from test",
      metadata: { themeId: "system" },
    });

    expect(vault.getUnlockedVault).toHaveBeenCalledTimes(1);
    expect(subtle.generateKey).toHaveBeenCalledTimes(1);
    expect(subtle.encrypt).toHaveBeenCalledTimes(2);
    expect(envelope).not.toHaveProperty("schema");
    expect(envelope).not.toHaveProperty("version");
    expect(envelope.signatures.device.kid).toBe("sig-kid-1");
    expect(typeof envelope.cipher.ciphertext).toBe("string");
    expect(
      new TextDecoder().decode(subtle.sign.mock.calls[0]?.[2] as Uint8Array),
    ).toBe(
      serializeDropEnvelopeForDeviceSignature(toDropEnvelopeSignable(envelope)),
    );
  });

  it("encodes canonical draft packs as V1 wire data before sealing", async () => {
    const subtle = installMockCrypto();
    subtle.generateKey.mockResolvedValue({} as CryptoKey);
    subtle.encrypt
      .mockResolvedValueOnce(Uint8Array.from([11, 12, 13]).buffer)
      .mockResolvedValueOnce(Uint8Array.from([21, 22, 23]).buffer)
      .mockResolvedValueOnce(Uint8Array.from([31, 32, 33]).buffer);
    subtle.exportKey.mockResolvedValue(Uint8Array.from([41, 42, 43]).buffer);
    subtle.sign.mockResolvedValue(Uint8Array.from([51, 52, 53]).buffer);
    const draftPack = {
      policy: "always" as const,
      source: "new-drop" as const,
      createdAt: 1_700_000_000_000,
      snapshots: [],
    };

    await new BrowserVoidCrypto({ vault: createVaultMock() as any }).seal({
      content: "Hello from test",
      draftPack,
    });

    const draftPlaintext = subtle.encrypt.mock.calls[1]?.[2] as Uint8Array;
    expect(JSON.parse(new TextDecoder().decode(draftPlaintext))).toEqual({
      version: 1,
      ...draftPack,
    });
  });

  it("opens envelopes after signature verification", async () => {
    const subtle = installMockCrypto();
    subtle.verify.mockResolvedValue(true);
    subtle.decrypt
      .mockResolvedValueOnce(Uint8Array.from([1, 2, 3, 4]).buffer)
      .mockResolvedValueOnce(new TextEncoder().encode("opened content").buffer);
    subtle.importKey.mockResolvedValue({} as CryptoKey);

    const vault = createVaultMock();

    const cryptoPort = new BrowserVoidCrypto({
      vault: vault as any,
    });

    const envelope: DropEnvelope = {
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

  it("opens V1-signed same-device envelopes after transport decoding", async () => {
    Object.defineProperty(globalThis, "crypto", {
      value: webcrypto,
      configurable: true,
    });
    const [encryptionPair, signingPair, providerSigningPair, contentKey] = (await Promise.all([
      crypto.subtle.generateKey(
        {
          name: "RSA-OAEP",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["encrypt", "decrypt"],
      ),
      crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
      ),
      crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
      ),
      crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
        "encrypt",
        "decrypt",
      ]),
    ])) as [CryptoKeyPair, CryptoKeyPair, CryptoKeyPair, CryptoKey];
    const [
      rawContentKey,
      encryptionPublicJwk,
      signingPublicJwk,
      providerSigningPublicJwk,
    ] = await Promise.all([
      crypto.subtle.exportKey("raw", contentKey),
      crypto.subtle.exportKey("jwk", encryptionPair.publicKey),
      crypto.subtle.exportKey("jwk", signingPair.publicKey),
      crypto.subtle.exportKey("jwk", providerSigningPair.publicKey),
    ]);
    const iv = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const [ciphertext, wrappedKey] = await Promise.all([
      crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        contentKey,
        new TextEncoder().encode("legacy same-device content"),
      ),
      crypto.subtle.encrypt(
        { name: "RSA-OAEP" },
        encryptionPair.publicKey,
        rawContentKey,
      ),
    ]);
    const envelope: DropEnvelope = {
      createdAt: 1_700_000_000_000,
      accountId: "legacy-account",
      cipher: {
        alg: "A256GCM",
        iv: Buffer.from(iv).toString("base64"),
        ciphertext: Buffer.from(ciphertext).toString("base64"),
      },
      keyEnvelope: {
        mode: "account-vault-rsa-oaep",
        kid: "legacy-enc-kid",
        wrappedKey: Buffer.from(wrappedKey).toString("base64"),
      },
      signatures: {
        device: {
          kid: "legacy-sig-kid",
          alg: "ECDSA_P256_SHA256",
          sig: "",
        },
      },
    };
    const v1SignaturePayload = serializeDropEnvelopeForDeviceSignature(
      toDropEnvelopeSignable(envelope),
    );
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      signingPair.privateKey,
      new TextEncoder().encode(v1SignaturePayload),
    );
    const deviceSignedV1Envelope = encodeDropEnvelope({
      ...envelope,
      signatures: {
        device: {
          ...envelope.signatures.device,
          sig: Buffer.from(signature).toString("base64"),
        },
      },
    });
    const deviceSignedEnvelope = decodeDropEnvelope(deviceSignedV1Envelope);
    expect(deviceSignedEnvelope).not.toBeNull();
    const v1ProviderSignaturePayload = serializeDropEnvelopeForProviderSignature(
      deviceSignedEnvelope!,
    );
    const providerSignature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      providerSigningPair.privateKey,
      new TextEncoder().encode(v1ProviderSignaturePayload),
    );
    const rawV1Envelope = encodeDropEnvelope({
      ...deviceSignedEnvelope!,
      signatures: {
        ...deviceSignedEnvelope!.signatures,
        provider: {
          kid: "provider-sig-kid",
          alg: "ECDSA_P256_SHA256",
          sig: Buffer.from(providerSignature).toString("base64"),
        },
      },
    });
    const decodedEnvelope = decodeDropEnvelope(rawV1Envelope);
    const vault = {
      getUnlockedVault: jest.fn(async () => ({
        accountId: "legacy-account",
        encryptionKid: "legacy-enc-kid",
        signingKid: "legacy-sig-kid",
        encryptionPublicJwk,
        signingPublicJwk,
        encryptionPublicKey: encryptionPair.publicKey,
        encryptionPrivateKey: encryptionPair.privateKey,
        signingPublicKey: signingPair.publicKey,
        signingPrivateKey: signingPair.privateKey,
      })),
    };

    expect(decodedEnvelope).not.toBeNull();
    expect(
      serializeDropEnvelopeForDeviceSignature(
        toDropEnvelopeSignable(decodedEnvelope!),
      ),
    ).toBe(v1SignaturePayload);
    expect(
      serializeDropEnvelopeForProviderSignature(decodedEnvelope!),
    ).toBe(v1ProviderSignaturePayload);
    expect(decodedEnvelope).not.toHaveProperty("deviceSignerPublicJwk");
    await expect(
      new BrowserVoidCrypto({
        vault: vault as any,
        providerSigningPublicJwk: JSON.stringify(providerSigningPublicJwk),
      }).open(decodedEnvelope!),
    ).resolves.toEqual({
      content: "legacy same-device content",
      metadata: undefined,
      draftPack: undefined,
    });
    await expect(
      new BrowserVoidCrypto({
        vault: vault as any,
        providerSigningPublicJwk: JSON.stringify(providerSigningPublicJwk),
      }).open({
        ...decodedEnvelope!,
        signatures: {
          ...decodedEnvelope!.signatures,
          provider: {
            ...decodedEnvelope!.signatures.provider!,
            sig: Buffer.from(new Uint8Array(64)).toString("base64"),
          },
        },
      }),
    ).rejects.toThrow("Provider signature verification failed.");
  });

  it("decodes legacy V1 encrypted draft packs to the canonical model", async () => {
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

    const cryptoPort = new BrowserVoidCrypto({
      vault: vault as any,
    });

    const envelope: DropEnvelope = {
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
    expect(payload.draftPack).toEqual({
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
    });
    expect(payload.draftPack).not.toHaveProperty("version");
    expect(subtle.decrypt).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid encrypted draft pack wire data safely", async () => {
    const subtle = installMockCrypto();
    subtle.verify.mockResolvedValue(true);
    subtle.decrypt
      .mockResolvedValueOnce(Uint8Array.from([1, 2, 3, 4]).buffer)
      .mockResolvedValueOnce(new TextEncoder().encode("opened content").buffer)
      .mockResolvedValueOnce(
        new TextEncoder().encode(
          JSON.stringify({ version: 1, policy: "invalid" }),
        ).buffer,
      );
    subtle.importKey.mockResolvedValue({} as CryptoKey);

    const payload = await new BrowserVoidCrypto({
      vault: createVaultMock() as any,
    }).open({
      ...createEscrowEnvelope(),
      draftCipher: {
        alg: "A256GCM",
        iv: "AQIDBA==",
        ciphertext: "CQoLDA==",
      },
    });

    expect(payload.content).toBe("opened content");
    expect(payload.draftPack).toBeUndefined();
  });

  it("wraps raw decrypt operation errors with context", async () => {
    const subtle = installMockCrypto();
    subtle.verify.mockResolvedValue(true);

    const operationError = new Error("The operation failed");
    operationError.name = "OperationError";
    subtle.decrypt.mockRejectedValue(operationError);

    const vault = createVaultMock();

    const cryptoPort = new BrowserVoidCrypto({
      vault: vault as any,
    });

    const envelope: DropEnvelope = {
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

    const cryptoPort = new BrowserVoidCrypto({
      vault: vault as any,
    });

    const envelope: DropEnvelope = {
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

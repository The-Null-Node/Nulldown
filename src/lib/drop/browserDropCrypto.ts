import {
  DROP_ENVELOPE_SCHEMA_V1,
  DROP_ENVELOPE_VERSION_V1,
  isDropDraftPackV1,
  serializeDropEnvelopeForDeviceSignature,
  serializeDropEnvelopeForProviderSignature,
  toDropEnvelopeSignable,
  type DropDraftPackV1,
  type DropEnvelopeV1,
  type DropPayload,
  type DropUnlockPolicy,
  type DropVisibility,
} from "../../../shared/drop/types";
import { fromBase64, toBase64 } from "./base64";
import {
  createPasskeyVault,
  type PasskeyVault,
  type UnlockedVault,
} from "./passkeyVault";

export interface DropSealOptions {
  visibility?: DropVisibility;
  unlockPolicy?: DropUnlockPolicy;
}

export interface DropOpenOptions {
  dropId?: string;
}

export interface DropCryptoPort {
  seal: (
    payload: DropPayload,
    options?: DropSealOptions,
  ) => Promise<DropEnvelopeV1>;
  open: (
    envelope: DropEnvelopeV1,
    options?: DropOpenOptions,
  ) => Promise<DropPayload>;
}

export interface BrowserDropCryptoOptions {
  vault?: PasskeyVault;
  providerSigningPublicJwk?: string;
  providerEncryptionPublicJwk?: string;
}

interface UnlockApiResponse {
  wrappedKey?: string;
  error?: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const cloneMetadata = (
  metadata?: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  if (!metadata) return undefined;

  try {
    if (typeof structuredClone === "function") {
      return structuredClone(metadata) as Record<string, unknown>;
    }
  } catch {
    // fall through to JSON clone
  }

  return JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>;
};

const importDeviceVerifyKey = (jwk: JsonWebKey) =>
  crypto.subtle.importKey(
    "jwk",
    jwk,
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    false,
    ["verify"],
  );

export class BrowserDropCrypto implements DropCryptoPort {
  private readonly vault: PasskeyVault;
  private readonly providerSigningPublicJwk?: string;
  private readonly providerEncryptionPublicJwk?: string;
  private providerVerifyKeyPromise: Promise<CryptoKey | null> | null = null;
  private providerEncryptionKeyPromise: Promise<{
    key: CryptoKey;
    kid: string;
  } | null> | null = null;

  constructor(options: BrowserDropCryptoOptions = {}) {
    this.vault = options.vault ?? createPasskeyVault();
    this.providerSigningPublicJwk = options.providerSigningPublicJwk;
    this.providerEncryptionPublicJwk = options.providerEncryptionPublicJwk;
  }

  async seal(
    payload: DropPayload,
    options: DropSealOptions = {},
  ): Promise<DropEnvelopeV1> {
    const vault = await this.vault.getUnlockedVault();
    const visibility = options.visibility ?? "unlisted";
    const unlockPolicy = options.unlockPolicy ?? "vault-only";

    const contentKey = await crypto.subtle.generateKey(
      {
        name: "AES-GCM",
        length: 256,
      },
      true,
      ["encrypt", "decrypt"],
    );

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
      },
      contentKey,
      textEncoder.encode(payload.content),
    );

    let draftCipher:
      | {
          alg: "A256GCM";
          iv: string;
          ciphertext: string;
        }
      | undefined;

    if (payload.draftPack) {
      const draftIv = crypto.getRandomValues(new Uint8Array(12));
      const draftCiphertext = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: draftIv,
        },
        contentKey,
        textEncoder.encode(JSON.stringify(payload.draftPack)),
      );

      draftCipher = {
        alg: "A256GCM",
        iv: toBase64(draftIv),
        ciphertext: toBase64(draftCiphertext),
      };
    }

    const rawContentKey = await crypto.subtle.exportKey("raw", contentKey);
    const wrappedKey = await crypto.subtle.encrypt(
      {
        name: "RSA-OAEP",
      },
      vault.encryptionPublicKey,
      rawContentKey,
    );

    let providerEscrow:
      | { mode: "provider-rsa-oaep"; kid: string; wrappedKey: string }
      | undefined;

    if (unlockPolicy === "provider-escrow") {
      const providerEncryption = await this.getProviderEncryptionKey();
      if (!providerEncryption) {
        throw new Error(
          "Provider unlock policy requires VITE_PROVIDER_ENCRYPTION_PUBLIC_JWK.",
        );
      }

      const escrowWrappedKey = await crypto.subtle.encrypt(
        {
          name: "RSA-OAEP",
        },
        providerEncryption.key,
        rawContentKey,
      );

      providerEscrow = {
        mode: "provider-rsa-oaep",
        kid: providerEncryption.kid,
        wrappedKey: toBase64(escrowWrappedKey),
      };
    }

    const signableEnvelope = {
      schema: DROP_ENVELOPE_SCHEMA_V1,
      version: DROP_ENVELOPE_VERSION_V1,
      createdAt: Date.now(),
      accountId: vault.accountId,
      visibility,
      unlockPolicy,
      metadata: cloneMetadata(payload.metadata),
      cipher: {
        alg: "A256GCM" as const,
        iv: toBase64(iv),
        ciphertext: toBase64(ciphertext),
      },
      draftCipher,
      keyEnvelope: {
        mode: "account-vault-rsa-oaep" as const,
        kid: vault.encryptionKid,
        wrappedKey: toBase64(wrappedKey),
      },
      deviceSignerPublicJwk: vault.signingPublicJwk,
      providerEscrow,
    };

    const signablePayload =
      serializeDropEnvelopeForDeviceSignature(signableEnvelope);

    const signature = await crypto.subtle.sign(
      {
        name: "ECDSA",
        hash: "SHA-256",
      },
      vault.signingPrivateKey,
      textEncoder.encode(signablePayload),
    );

    return {
      ...signableEnvelope,
      signatures: {
        device: {
          kid: vault.signingKid,
          alg: "ECDSA_P256_SHA256",
          sig: toBase64(signature),
        },
      },
    };
  }

  async open(
    envelope: DropEnvelopeV1,
    options: DropOpenOptions = {},
  ): Promise<DropPayload> {
    const vault = await this.vault.getUnlockedVault();
    await this.verifyDeviceSignature(envelope, vault);
    await this.verifyProviderSignature(envelope);

    let rawContentKey: ArrayBuffer | null = null;

    try {
      rawContentKey = await crypto.subtle.decrypt(
        {
          name: "RSA-OAEP",
        },
        vault.encryptionPrivateKey,
        fromBase64(envelope.keyEnvelope.wrappedKey),
      );
    } catch (error) {
      if (
        envelope.unlockPolicy === "provider-escrow" &&
        envelope.providerEscrow &&
        options.dropId
      ) {
        rawContentKey = await this.requestEscrowUnlockedKey(
          options.dropId,
          vault,
        );
      } else {
        throw error;
      }
    }

    if (!rawContentKey) {
      throw new Error("Unable to unwrap drop encryption key.");
    }

    const contentKey = await this.importContentKey(rawContentKey, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64(envelope.cipher.iv),
      },
      contentKey,
      fromBase64(envelope.cipher.ciphertext),
    );

    const draftPack = await this.openDraftPack(envelope, contentKey);

    return {
      content: textDecoder.decode(plaintext),
      metadata: cloneMetadata(envelope.metadata),
      draftPack,
    };
  }

  private async openDraftPack(
    envelope: DropEnvelopeV1,
    contentKey: CryptoKey,
  ): Promise<DropDraftPackV1 | undefined> {
    if (!envelope.draftCipher) {
      return undefined;
    }

    try {
      const draftPlaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: fromBase64(envelope.draftCipher.iv),
        },
        contentKey,
        fromBase64(envelope.draftCipher.ciphertext),
      );

      const parsed = JSON.parse(textDecoder.decode(draftPlaintext)) as unknown;
      if (!isDropDraftPackV1(parsed)) {
        return undefined;
      }

      return parsed;
    } catch (error) {
      console.warn("Failed to decode draft pack from drop envelope:", error);
      return undefined;
    }
  }

  private async requestEscrowUnlockedKey(
    dropId: string,
    vault: UnlockedVault,
  ): Promise<ArrayBuffer> {
    const response = await fetch(`/api/unlock/${encodeURIComponent(dropId)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requesterPublicJwk: vault.encryptionPublicJwk,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(body || "Provider unlock request failed.");
    }

    const data = (await response.json()) as UnlockApiResponse;
    if (!data.wrappedKey) {
      throw new Error(
        data.error || "Provider did not return unlocked key material.",
      );
    }

    return crypto.subtle.decrypt(
      {
        name: "RSA-OAEP",
      },
      vault.encryptionPrivateKey,
      fromBase64(data.wrappedKey),
    );
  }

  private async loadProviderVerifyKey(): Promise<CryptoKey | null> {
    const raw =
      this.providerSigningPublicJwk ??
      import.meta.env?.VITE_PROVIDER_SIGNING_PUBLIC_JWK;

    if (!raw) {
      return null;
    }

    try {
      const jwk = JSON.parse(raw) as JsonWebKey;
      return await crypto.subtle.importKey(
        "jwk",
        jwk,
        {
          name: "ECDSA",
          namedCurve: "P-256",
        },
        false,
        ["verify"],
      );
    } catch (error) {
      console.error("Invalid provider signing public JWK:", error);
      return null;
    }
  }

  private async getProviderVerifyKey(): Promise<CryptoKey | null> {
    if (!this.providerVerifyKeyPromise) {
      this.providerVerifyKeyPromise = this.loadProviderVerifyKey();
    }

    return this.providerVerifyKeyPromise;
  }

  private async loadProviderEncryptionKey(): Promise<{
    key: CryptoKey;
    kid: string;
  } | null> {
    const raw =
      this.providerEncryptionPublicJwk ??
      import.meta.env?.VITE_PROVIDER_ENCRYPTION_PUBLIC_JWK;

    if (!raw) {
      return null;
    }

    try {
      const jwk = JSON.parse(raw) as JsonWebKey;
      const key = await crypto.subtle.importKey(
        "jwk",
        jwk,
        {
          name: "RSA-OAEP",
          hash: "SHA-256",
        },
        false,
        ["encrypt"],
      );

      const source = jwk as unknown as Record<string, unknown>;
      const kid = typeof source.kid === "string" ? source.kid : "provider";
      return { key, kid };
    } catch (error) {
      console.error("Invalid provider encryption public JWK:", error);
      return null;
    }
  }

  private async getProviderEncryptionKey(): Promise<{
    key: CryptoKey;
    kid: string;
  } | null> {
    if (!this.providerEncryptionKeyPromise) {
      this.providerEncryptionKeyPromise = this.loadProviderEncryptionKey();
    }

    return this.providerEncryptionKeyPromise;
  }

  private async verifyProviderSignature(envelope: DropEnvelopeV1) {
    const signature = envelope.signatures.provider;
    if (!signature) return;

    const verifyKey = await this.getProviderVerifyKey();
    if (!verifyKey) {
      throw new Error(
        "Provider signature exists but no provider verify key is configured.",
      );
    }

    const signedPayload = serializeDropEnvelopeForProviderSignature(envelope);
    const isValid = await crypto.subtle.verify(
      {
        name: "ECDSA",
        hash: "SHA-256",
      },
      verifyKey,
      fromBase64(signature.sig),
      textEncoder.encode(signedPayload),
    );

    if (!isValid) {
      throw new Error("Provider signature verification failed.");
    }
  }

  private async verifyDeviceSignature(
    envelope: DropEnvelopeV1,
    vault: UnlockedVault,
  ) {
    const signablePayload = serializeDropEnvelopeForDeviceSignature(
      toDropEnvelopeSignable(envelope),
    );

    let verifyKey: CryptoKey;

    if (envelope.deviceSignerPublicJwk) {
      verifyKey = await importDeviceVerifyKey(envelope.deviceSignerPublicJwk);
    } else {
      if (vault.accountId !== envelope.accountId) {
        throw new Error(
          "This drop belongs to a different account vault and cannot be decrypted on this device.",
        );
      }

      verifyKey = vault.signingPublicKey;
    }

    const isValid = await crypto.subtle.verify(
      {
        name: "ECDSA",
        hash: "SHA-256",
      },
      verifyKey,
      fromBase64(envelope.signatures.device.sig),
      textEncoder.encode(signablePayload),
    );

    if (!isValid) {
      throw new Error("Device signature verification failed.");
    }
  }

  private importContentKey(rawKey: BufferSource, usage: KeyUsage[]) {
    return crypto.subtle.importKey(
      "raw",
      rawKey,
      {
        name: "AES-GCM",
      },
      false,
      usage,
    );
  }
}

export const createBrowserDropCrypto = (
  options: BrowserDropCryptoOptions = {},
) => new BrowserDropCrypto(options);

export const browserDropCrypto = createBrowserDropCrypto();

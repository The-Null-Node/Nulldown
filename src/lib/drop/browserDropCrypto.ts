import {
  DROP_ENVELOPE_SCHEMA_V1,
  DROP_ENVELOPE_VERSION_V1,
  serializeDropEnvelopeForDeviceSignature,
  serializeDropEnvelopeForProviderSignature,
  toDropEnvelopeSignable,
  type DropEnvelopeV1,
  type DropPayload,
} from "../../../shared/drop/types";
import { fromBase64, toBase64 } from "./base64";
import {
  createPasskeyVault,
  type PasskeyVault,
  type UnlockedVault,
} from "./passkeyVault";

export interface DropCryptoPort {
  seal: (payload: DropPayload) => Promise<DropEnvelopeV1>;
  open: (envelope: DropEnvelopeV1) => Promise<DropPayload>;
}

export interface BrowserDropCryptoOptions {
  vault?: PasskeyVault;
  providerSigningPublicJwk?: string;
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

export class BrowserDropCrypto implements DropCryptoPort {
  private readonly vault: PasskeyVault;
  private readonly providerSigningPublicJwk?: string;
  private providerVerifyKeyPromise: Promise<CryptoKey | null> | null = null;

  constructor(options: BrowserDropCryptoOptions = {}) {
    this.vault = options.vault ?? createPasskeyVault();
    this.providerSigningPublicJwk = options.providerSigningPublicJwk;
  }

  async seal(payload: DropPayload): Promise<DropEnvelopeV1> {
    const vault = await this.vault.getUnlockedVault();
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

    const rawContentKey = await crypto.subtle.exportKey("raw", contentKey);
    const wrappedKey = await crypto.subtle.encrypt(
      {
        name: "RSA-OAEP",
      },
      vault.encryptionPublicKey,
      rawContentKey,
    );

    const signableEnvelope = {
      schema: DROP_ENVELOPE_SCHEMA_V1,
      version: DROP_ENVELOPE_VERSION_V1,
      createdAt: Date.now(),
      accountId: vault.accountId,
      metadata: cloneMetadata(payload.metadata),
      cipher: {
        alg: "A256GCM" as const,
        iv: toBase64(iv),
        ciphertext: toBase64(ciphertext),
      },
      keyEnvelope: {
        mode: "account-vault-rsa-oaep" as const,
        kid: vault.encryptionKid,
        wrappedKey: toBase64(wrappedKey),
      },
    };

    const signablePayload = serializeDropEnvelopeForDeviceSignature(
      signableEnvelope,
    );

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

  async open(envelope: DropEnvelopeV1): Promise<DropPayload> {
    const vault = await this.verifyDeviceSignature(envelope);
    await this.verifyProviderSignature(envelope);

    const rawContentKey = await crypto.subtle.decrypt(
      {
        name: "RSA-OAEP",
      },
      vault.encryptionPrivateKey,
      fromBase64(envelope.keyEnvelope.wrappedKey),
    );

    const contentKey = await this.importContentKey(rawContentKey, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64(envelope.cipher.iv),
      },
      contentKey,
      fromBase64(envelope.cipher.ciphertext),
    );

    return {
      content: textDecoder.decode(plaintext),
      metadata: cloneMetadata(envelope.metadata),
    };
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
  ): Promise<UnlockedVault> {
    const vault = await this.vault.getUnlockedVault();

    if (vault.accountId !== envelope.accountId) {
      throw new Error(
        "This drop belongs to a different account vault and cannot be decrypted on this device.",
      );
    }

    const signablePayload = serializeDropEnvelopeForDeviceSignature(
      toDropEnvelopeSignable(envelope),
    );

    const isValid = await crypto.subtle.verify(
      {
        name: "ECDSA",
        hash: "SHA-256",
      },
      vault.signingPublicKey,
      fromBase64(envelope.signatures.device.sig),
      textEncoder.encode(signablePayload),
    );

    if (!isValid) {
      throw new Error("Device signature verification failed.");
    }

    return vault;
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

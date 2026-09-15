/*
This module seals browser-authored payloads into `nmdn.drop.v1` envelopes and reopens
them later. Device signatures are verified before content keys are trusted, and provider
escrow is only used as a fallback when the local vault cannot unwrap the stored key.
*/

import {
  isDropDraftPackV1,
  serializeDropEnvelopeForDeviceSignature,
  serializeDropEnvelopeForProviderSignature,
  toDropEnvelopeSignable,
  type DropDraftPackV1,
  type DropEnvelopeV1,
  type DropPayload,
  type DropUnlockPolicy,
  type DropVisibility,
} from "../../../../shared/drop/types";
import { sealDropForAuthoring } from "../../../../shared/drop/authoringCrypto";
import { fromBase64 } from "./base64";
import {
  createPasskeyVault,
  type PasskeyVault,
  type UnlockedVault,
} from "../vault/passkeyVault";

/** Options for sealing plaintext payloads into encrypted drop envelopes. */
export interface VoidSealOptions {
  visibility?: DropVisibility;
  unlockPolicy?: DropUnlockPolicy;
}

/** Options for opening encrypted drop envelopes through browser crypto. */
export interface VoidOpenOptions {
  dropId?: string;
}

/**
 * Cryptographic boundary for the void runtime.
 *
 * Implementations seal plaintext into `DropEnvelopeV1` records and open sealed
 * envelopes back into payloads, but they do not own persistence.
 */
export interface VoidCrypto {
  seal: (
    payload: DropPayload,
    options?: VoidSealOptions,
  ) => Promise<DropEnvelopeV1>;
  open: (
    envelope: DropEnvelopeV1,
    options?: VoidOpenOptions,
  ) => Promise<DropPayload>;
}

/** Options for constructing browser Web Crypto based void crypto. */
export interface BrowserVoidCryptoOptions {
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

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    const prefix =
      error.name && error.name !== "Error" ? `${error.name}: ` : "";
    return `${prefix}${error.message}`.trim();
  }

  return String(error);
};

const getDropLabel = (dropId: string | undefined): string =>
  dropId ? `drop "${dropId}"` : "drop";

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

/** Browser implementation of `VoidCrypto` backed by the passkey vault. */
export class BrowserVoidCrypto implements VoidCrypto {
  private readonly vault: PasskeyVault;
  private readonly providerSigningPublicJwk?: string;
  private readonly providerEncryptionPublicJwk?: string;
  private providerVerifyKeyPromise: Promise<CryptoKey | null> | null = null;
  private providerEncryptionKeyPromise: Promise<{
    key: CryptoKey;
    kid: string;
  } | null> | null = null;

  constructor(options: BrowserVoidCryptoOptions = {}) {
    this.vault = options.vault ?? createPasskeyVault();
    this.providerSigningPublicJwk = options.providerSigningPublicJwk;
    this.providerEncryptionPublicJwk = options.providerEncryptionPublicJwk;
  }

  async seal(
    payload: DropPayload,
    options: VoidSealOptions = {},
  ): Promise<DropEnvelopeV1> {
    const vault = await this.vault.getUnlockedVault();
    const visibility = options.visibility ?? "unlisted";
    const unlockPolicy = options.unlockPolicy ?? "vault-only";
    let providerEncryption:
      | { key: CryptoKey; kid: string }
      | null
      | undefined;
    if (unlockPolicy === "provider-escrow") {
      providerEncryption = await this.getProviderEncryptionKey();
      if (!providerEncryption) {
        throw new Error(
          "Provider unlock policy requires VITE_PROVIDER_ENCRYPTION_PUBLIC_JWK.",
        );
      }
    }
    return sealDropForAuthoring({
      payload,
      accountEncryption: {
        accountId: vault.accountId,
        encryptionKid: vault.encryptionKid,
        encryptionPublicJwk: vault.encryptionPublicJwk,
        encryptionPublicKey: vault.encryptionPublicKey,
      },
      delegateSigning: {
        signingKid: vault.signingKid,
        signingPublicJwk: vault.signingPublicJwk,
        signingPrivateKey: vault.signingPrivateKey,
      },
      providerEncryption: providerEncryption
        ? { kid: providerEncryption.kid, publicKey: providerEncryption.key }
        : undefined,
      visibility,
      unlockPolicy,
      metadata: cloneMetadata(payload.metadata),
    });
  }

  async open(
    envelope: DropEnvelopeV1,
    options: VoidOpenOptions = {},
  ): Promise<DropPayload> {
    const dropLabel = getDropLabel(options.dropId);
    const vault = await this.vault.getUnlockedVault();
    // Verify signatures before touching wrapped keys so tampered envelopes fail closed.
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
        try {
          // Provider escrow is the recovery path for multi-device access, not the primary unlock flow.
          rawContentKey = await this.requestEscrowUnlockedKey(
            options.dropId,
            vault,
          );
        } catch (escrowError) {
          console.error(
            `[void-crypto] Provider escrow unlock failed for ${dropLabel}:`,
            escrowError,
          );
          throw new Error(
            `Failed provider escrow unlock for ${dropLabel}: ${getErrorMessage(
              escrowError,
            )}`,
          );
        }
      } else {
        console.error(
          `[void-crypto] Failed to unwrap content key for ${dropLabel}:`,
          error,
        );
        throw new Error(
          `Unable to decrypt ${dropLabel} with the current vault. ` +
            `This drop may belong to a different account vault or require provider escrow. ` +
            `Reason: ${getErrorMessage(error)}`,
        );
      }
    }

    if (!rawContentKey) {
      throw new Error("Unable to unwrap drop encryption key.");
    }

    const contentKey = await this.importContentKey(rawContentKey, ["decrypt"]);
    let plaintext: ArrayBuffer;

    try {
      plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: fromBase64(envelope.cipher.iv),
        },
        contentKey,
        fromBase64(envelope.cipher.ciphertext),
      );
    } catch (error) {
      console.error(
        `[void-crypto] Failed to decrypt payload for ${dropLabel}:`,
        error,
      );
      throw new Error(
        `Unable to decrypt payload for ${dropLabel}. ` +
          `The encrypted content may be corrupted or key material is invalid. ` +
          `Reason: ${getErrorMessage(error)}`,
      );
    }

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
    // The server re-wraps the content key to this vault's public key; the browser still performs the final unwrap.
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
      // Older same-device drops may omit the embedded verify key and instead rely on the current vault identity.
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

/** Creates browser crypto for the default void runtime. */
export const createBrowserVoidCrypto = (
  options: BrowserVoidCryptoOptions = {},
) => new BrowserVoidCrypto(options);

export const browserVoidCrypto = createBrowserVoidCrypto();

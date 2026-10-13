import type {
  DropEnvelope,
  DropMetadata,
} from "../../../../../shared/drop/types";
import {
  serializeDropEnvelopeForDeviceSignature,
  serializeDropEnvelopeForProviderSignature,
} from "../../../../../shared/drop/codecs/envelope-v1";
import { providerCrypto } from "../provider-crypto";

/** Reseals one owner publication using the existing recipients and a fresh IV; no persistence. */
export const sealPublishedEnvelope = async (
  original: DropEnvelope,
  content: string,
  metadata: DropMetadata,
  encryptionPrivateKey: string,
  signingPrivateKey: string,
): Promise<DropEnvelope> => {
  if (original.unlockPolicy !== "provider-escrow" || !original.providerEscrow) {
    throw new Error("publication_escrow_required");
  }
  const raw = await providerCrypto.unwrapProviderContentKey(
    encryptionPrivateKey,
    original.providerEscrow.wrappedKey,
  );
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(content),
  );
  const signingJwk = JSON.parse(signingPrivateKey) as JsonWebKey;
  const signer = providerCrypto.deriveProviderSigningPublicJwk(signingJwk);
  // A new provider-authored revision must not retain the old device signature,
  // delegation or encrypted draft history for a different content frame.
  const signable = {
    createdAt: original.createdAt,
    accountId: original.accountId,
    visibility: original.visibility,
    unlockPolicy: original.unlockPolicy,
    keyEnvelope: original.keyEnvelope,
    providerEscrow: original.providerEscrow,
    metadata,
    cipher: {
      alg: "A256GCM" as const,
      iv: providerCrypto.toBase64(iv),
      ciphertext: providerCrypto.toBase64(ciphertext),
    },
    deviceSignerPublicJwk: signer.jwk,
  };
  const device = await providerCrypto.signWithProviderKey(
    serializeDropEnvelopeForDeviceSignature(signable),
    signingJwk,
  );
  const envelope: DropEnvelope = {
    ...signable,
    signatures: {
      device: {
        kid: signer.kid,
        alg: "ECDSA_P256_SHA256",
        sig: providerCrypto.toBase64(device),
      },
    },
  };
  const provider = await providerCrypto.signWithProviderKey(
    serializeDropEnvelopeForProviderSignature(envelope),
    signingJwk,
  );
  envelope.signatures.provider = {
    kid: signer.kid,
    alg: "ECDSA_P256_SHA256",
    sig: providerCrypto.toBase64(provider),
  };
  return envelope;
};

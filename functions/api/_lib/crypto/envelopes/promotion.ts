import {
  serializeDropEnvelopeForDeviceSignature,
} from "../../../../../shared/drop/codecs/envelope-v1";
import type {
  DropEnvelope,
  DropMetadata,
} from "../../../../../shared/drop/types";
import { providerCrypto } from "../provider-crypto";

/** Inputs for creating a provider-sealed drop envelope from promoted branch content. */
export interface CreatePromotedEnvelopeInput {
  content: string;
  accountId: string;
  metadata: DropMetadata;
  providerEncryptionPrivateJwk: string;
  providerSigningPrivateJwk: string;
}

/** Creates a signed provider-escrow envelope for promoted branch content. */
export const createPromotedEnvelope = async (
  input: CreatePromotedEnvelopeInput,
): Promise<DropEnvelope> => {
  const encryptionPrivateJwk = JSON.parse(
    input.providerEncryptionPrivateJwk,
  ) as JsonWebKey;

  const signingPrivateJwk = JSON.parse(
    input.providerSigningPrivateJwk,
  ) as JsonWebKey;

  const { jwk: encryptionPublicJwk, kid: keyId } =
    providerCrypto.deriveProviderEncryptionPublicJwk(encryptionPrivateJwk);
  const { jwk: signingPublicJwk, kid: signingKeyId } =
    providerCrypto.deriveProviderSigningPublicJwk(signingPrivateJwk);
  const encryptedContent = await providerCrypto.encryptTextWithNewContentKey(
    input.content,
  );
  const wrappedKey =
    await providerCrypto.wrapRawContentKeyWithProviderPublicJwk(
      encryptionPublicJwk,
      encryptedContent.rawContentKey,
    );
  const escrowWrappedKey =
    await providerCrypto.wrapRawContentKeyWithProviderPublicJwk(
      encryptionPublicJwk,
      encryptedContent.rawContentKey,
    );

  const now = Date.now();

  const signableEnvelope = {
    createdAt: now,
    accountId: input.accountId,
    visibility: "unlisted" as const,
    unlockPolicy: "provider-escrow" as const,
    metadata: input.metadata,
    cipher: {
      alg: "A256GCM" as const,
      iv: providerCrypto.encodeIv(encryptedContent.iv),
      ciphertext: providerCrypto.toBase64(encryptedContent.ciphertext),
    },
    keyEnvelope: {
      mode: "account-vault-rsa-oaep" as const,
      kid: keyId,
      wrappedKey: providerCrypto.toBase64(wrappedKey),
    },
    providerEscrow: {
      mode: "provider-rsa-oaep" as const,
      kid: keyId,
      wrappedKey: providerCrypto.toBase64(escrowWrappedKey),
    },
    deviceSignerPublicJwk: signingPublicJwk,
  };

  const signaturePayload =
    serializeDropEnvelopeForDeviceSignature(signableEnvelope);
  const signature = await providerCrypto.signWithProviderKey(
    signaturePayload,
    signingPrivateJwk,
  );

  return {
    ...signableEnvelope,
    signatures: {
      device: {
        kid: signingKeyId,
        alg: "ECDSA_P256_SHA256",
        sig: providerCrypto.toBase64(signature),
      },
    },
  };
};

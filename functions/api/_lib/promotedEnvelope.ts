import {
  DROP_ENVELOPE_SCHEMA_V1,
  DROP_ENVELOPE_VERSION_V1,
  serializeDropEnvelopeForDeviceSignature,
  type DropEnvelopeV1,
  type DropMetadata,
} from "../../../shared/drop/types";
import { serverVoidCrypto } from "./void/serverVoidCrypto";

export interface CreatePromotedEnvelopeInput {
  content: string;
  accountId: string;
  metadata: DropMetadata;
  providerEncryptionPrivateJwk: string;
  providerSigningPrivateJwk: string;
}

export const createPromotedEnvelope = async (
  input: CreatePromotedEnvelopeInput,
): Promise<DropEnvelopeV1> => {
  const encryptionPrivateJwk = JSON.parse(
    input.providerEncryptionPrivateJwk,
  ) as JsonWebKey;
  const signingPrivateJwk = JSON.parse(
    input.providerSigningPrivateJwk,
  ) as JsonWebKey;

  const { jwk: encryptionPublicJwk, kid: keyId } =
    serverVoidCrypto.deriveProviderEncryptionPublicJwk(encryptionPrivateJwk);
  const { jwk: signingPublicJwk, kid: signingKeyId } =
    serverVoidCrypto.deriveProviderSigningPublicJwk(signingPrivateJwk);
  const encryptedContent = await serverVoidCrypto.encryptTextWithNewContentKey(
    input.content,
  );
  const wrappedKey =
    await serverVoidCrypto.wrapRawContentKeyWithProviderPublicJwk(
      encryptionPublicJwk,
      encryptedContent.rawContentKey,
    );
  const escrowWrappedKey =
    await serverVoidCrypto.wrapRawContentKeyWithProviderPublicJwk(
      encryptionPublicJwk,
      encryptedContent.rawContentKey,
    );

  const now = Date.now();

  const signableEnvelope = {
    schema: DROP_ENVELOPE_SCHEMA_V1,
    version: DROP_ENVELOPE_VERSION_V1,
    createdAt: now,
    accountId: input.accountId,
    visibility: "unlisted" as const,
    unlockPolicy: "provider-escrow" as const,
    metadata: input.metadata,
    cipher: {
      alg: "A256GCM" as const,
      iv: serverVoidCrypto.encodeIv(encryptedContent.iv),
      ciphertext: serverVoidCrypto.toBase64(encryptedContent.ciphertext),
    },
    keyEnvelope: {
      mode: "account-vault-rsa-oaep" as const,
      kid: keyId,
      wrappedKey: serverVoidCrypto.toBase64(wrappedKey),
    },
    providerEscrow: {
      mode: "provider-rsa-oaep" as const,
      kid: keyId,
      wrappedKey: serverVoidCrypto.toBase64(escrowWrappedKey),
    },
    deviceSignerPublicJwk: signingPublicJwk,
  };

  const signaturePayload =
    serializeDropEnvelopeForDeviceSignature(signableEnvelope);
  const signature = await serverVoidCrypto.signWithProviderKey(
    signaturePayload,
    signingPrivateJwk,
  );

  return {
    ...signableEnvelope,
    signatures: {
      device: {
        kid: signingKeyId,
        alg: "ECDSA_P256_SHA256",
        sig: serverVoidCrypto.toBase64(signature),
      },
    },
  };
};

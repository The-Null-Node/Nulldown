import {
  serializeDropEnvelopeForProviderSignature,
  type DropEnvelopeV1,
} from "../../../shared/drop/types";
import { serializeError, type RequestLogger } from "./logger";
import { serverVoidCrypto } from "./void/serverVoidCrypto";

/** Environment values needed to attach provider signatures to stored envelopes. */
export interface ProviderSigningEnv {
  PROVIDER_SIGNING_PRIVATE_JWK?: string;
}

/**
 * Adds a provider signature to the exact envelope that will be stored.
 *
 * Invalid or absent provider keys are fail-open so drop creation remains
 * available, but the error is logged for operational visibility.
 */
export const signProviderEnvelope = async (
  envelope: DropEnvelopeV1,
  env: ProviderSigningEnv,
  logger: RequestLogger,
): Promise<DropEnvelopeV1> => {
  const rawProviderKey = env.PROVIDER_SIGNING_PRIVATE_JWK;
  if (!rawProviderKey) {
    return envelope;
  }

  let jwk: JsonWebKey;

  try {
    jwk = JSON.parse(rawProviderKey) as JsonWebKey;
  } catch (error) {
    logger.error("store.provider_signing_key_invalid_json", {
      error: serializeError(error),
    });
    return envelope;
  }

  const signedPayload = serializeDropEnvelopeForProviderSignature(envelope);
  const signature = await serverVoidCrypto.signWithProviderKey(
    signedPayload,
    jwk,
  );

  const keyIdSource = jwk as unknown as Record<string, unknown>;
  const keyId =
    typeof keyIdSource.kid === "string" ? keyIdSource.kid : "provider";

  logger.debug("store.provider_signature_applied", {
    providerKeyId: keyId,
  });

  return {
    ...envelope,
    signatures: {
      ...envelope.signatures,
      provider: {
        kid: keyId,
        alg: "ECDSA_P256_SHA256",
        sig: serverVoidCrypto.toBase64(signature),
      },
    },
  };
};

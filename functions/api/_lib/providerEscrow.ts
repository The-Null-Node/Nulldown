/*
This is the narrow server-side escape hatch for provider-escrow flows. Most of the app
keeps plaintext in the browser, but branch bootstrapping and unlock handshakes sometimes
need the provider key to rehydrate content or re-wrap the content key for another device.
Treat every call site here as a trust boundary.
*/

import {
  isDropEnvelopeV1,
  type DropEnvelopeV1,
  type DropPayload,
} from "../../../shared/drop/types";
import { serverVoidCrypto } from "./void/serverVoidCrypto";

/** Opens a provider-escrowed drop envelope into plaintext payload material. */
export const decryptProviderEscrowEnvelope = async (
  envelope: DropEnvelopeV1,
  rawProviderPrivateKey: string,
): Promise<DropPayload> => {
  if (envelope.unlockPolicy !== "provider-escrow" || !envelope.providerEscrow) {
    throw new Error("Drop does not allow provider escrow unlock.");
  }

  const rawContentKey = await serverVoidCrypto.unwrapProviderContentKey(
    rawProviderPrivateKey,
    envelope.providerEscrow.wrappedKey,
  );
  const content = await serverVoidCrypto.decryptCipherText(
    rawContentKey,
    envelope.cipher,
  );
  const draftPack = await serverVoidCrypto.decryptDraftPack(
    rawContentKey,
    envelope.draftCipher,
  );

  return {
    content,
    metadata: envelope.metadata,
    draftPack,
  };
};

/** Parses a stored drop envelope, returning null when the value is not JSON envelope data. */
export const parseStoredEnvelope = (raw: string): DropEnvelopeV1 | null => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isDropEnvelopeV1(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/*
This is the narrow server-side escape hatch for provider-escrow flows. Most of the app
keeps plaintext in the browser, but branch bootstrapping and unlock handshakes sometimes
need the provider key to rehydrate content or re-wrap the content key for another device.
Treat every call site here as a trust boundary.
*/

import { decodeDropEnvelope } from "../../../../../shared/drop/codecs/envelope-v1";
import type {
  DropEnvelope,
  DropPayload,
} from "../../../../../shared/drop/types";
import { providerCrypto } from "../provider-crypto";

/** Opens a provider-escrowed drop envelope into plaintext payload material. */
export const decryptProviderEscrowEnvelope = async (
  envelope: DropEnvelope,
  rawProviderPrivateKey: string,
): Promise<DropPayload> => {
  if (envelope.unlockPolicy !== "provider-escrow" || !envelope.providerEscrow) {
    throw new Error("Drop does not allow provider escrow unlock.");
  }

  const rawContentKey = await providerCrypto.unwrapProviderContentKey(
    rawProviderPrivateKey,
    envelope.providerEscrow.wrappedKey,
  );
  const content = await providerCrypto.decryptCipherText(
    rawContentKey,
    envelope.cipher,
  );
  const draftPack = await providerCrypto.decryptDraftPack(
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
export const parseStoredEnvelope = (raw: string): DropEnvelope | null => {
  try {
    return decodeDropEnvelope(JSON.parse(raw));
  } catch {
    return null;
  }
};

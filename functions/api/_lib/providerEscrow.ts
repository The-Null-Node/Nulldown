/*
This is the narrow server-side escape hatch for provider-escrow flows. Most of the app
keeps plaintext in the browser, but branch bootstrapping and unlock handshakes sometimes
need the provider key to rehydrate content or re-wrap the content key for another device.
Treat every call site here as a trust boundary.
*/

import {
  isDropEnvelopeV1,
  isDropDraftPackV1,
  type DropEnvelopeV1,
  type DropPayload,
} from "../../../shared/drop/types";

const textDecoder = new TextDecoder();

export const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
};

export const toBase64 = (value: ArrayBuffer): string => {
  const bytes = new Uint8Array(value);
  let binary = "";

  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary);
};

export const parseProviderPrivateKey = async (
  raw: string,
): Promise<CryptoKey> => {
  const jwk = JSON.parse(raw) as JsonWebKey;
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    {
      name: "RSA-OAEP",
      hash: "SHA-256",
    },
    false,
    ["decrypt"],
  );
};

export const parseRequesterPublicKey = async (
  jwk: JsonWebKey,
): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "jwk",
    jwk,
    {
      name: "RSA-OAEP",
      hash: "SHA-256",
    },
    false,
    ["encrypt"],
  );

const importAesKey = (
  rawContentKey: ArrayBuffer,
  usages: Array<"encrypt" | "decrypt">,
) =>
  crypto.subtle.importKey(
    "raw",
    rawContentKey,
    { name: "AES-GCM" },
    false,
    usages,
  );

export const decryptProviderEscrowEnvelope = async (
  envelope: DropEnvelopeV1,
  rawProviderPrivateKey: string,
): Promise<DropPayload> => {
  if (envelope.unlockPolicy !== "provider-escrow" || !envelope.providerEscrow) {
    throw new Error("Drop does not allow provider escrow unlock.");
  }

  const providerPrivateKey = await parseProviderPrivateKey(
    rawProviderPrivateKey,
  );
  const rawContentKey = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    providerPrivateKey,
    fromBase64(envelope.providerEscrow.wrappedKey),
  );

  const contentKey = await importAesKey(rawContentKey, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64(envelope.cipher.iv),
    },
    contentKey,
    fromBase64(envelope.cipher.ciphertext),
  );

  let draftPack: DropPayload["draftPack"];
  if (envelope.draftCipher) {
    try {
      // Draft history is optional; a bad draft pack should not make the main content unreadable.
      const draftPlaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: fromBase64(envelope.draftCipher.iv),
        },
        contentKey,
        fromBase64(envelope.draftCipher.ciphertext),
      );
      const parsed = JSON.parse(textDecoder.decode(draftPlaintext)) as unknown;
      if (isDropDraftPackV1(parsed)) {
        draftPack = parsed;
      }
    } catch {
      draftPack = undefined;
    }
  }

  return {
    content: textDecoder.decode(plaintext),
    metadata: envelope.metadata,
    draftPack,
  };
};

export const parseStoredEnvelope = (raw: string): DropEnvelopeV1 | null => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isDropEnvelopeV1(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

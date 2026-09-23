import { serializeCanonicalJson } from "../../../../../shared/drop/types";
import {
  isAccountSigningPublicJwk,
  type AccountEncryptionRecipient,
} from "./records";

const textEncoder = new TextEncoder();

const fromBase64Url = (value: string): Uint8Array => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

/** Serializes exact account proof bytes, preserving the legacy recipient-free shape. */
export const serializeAccountProof = (
  accountId: string,
  signedAt: number,
  recipient?: AccountEncryptionRecipient,
): string =>
  recipient
    ? `nulldown-account-auth\n${accountId}\n${signedAt}\n${serializeCanonicalJson(recipient)}`
    : `nulldown-account-auth\n${accountId}\n${signedAt}`;

/** Verifies a signed account proof against the account public key. */
export const verifyAccountProof = async (input: {
  accountId: string;
  signingPublicJwk: JsonWebKey;
  signedAt: number;
  signature: string;
  recipient?: AccountEncryptionRecipient;
}): Promise<boolean> => {
  if (!isAccountSigningPublicJwk(input.signingPublicJwk)) {
    return false;
  }

  const skew = Math.abs(Date.now() - input.signedAt);
  if (skew > 5 * 60 * 1000) {
    return false;
  }

  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      input.signingPublicJwk,
      {
        name: "ECDSA",
        namedCurve: "P-256",
      },
      false,
      ["verify"],
    );
    const signatureBytes = fromBase64Url(input.signature);
    const message = serializeAccountProof(
      input.accountId,
      input.signedAt,
      input.recipient,
    );
    return await crypto.subtle.verify(
      {
        name: "ECDSA",
        hash: "SHA-256",
      },
      key,
      signatureBytes,
      textEncoder.encode(message),
    );
  } catch {
    return false;
  }
};

import {
  serializeDropEnvelopeForDeviceSignature,
  toDropEnvelopeSignable,
  type DropEnvelopeV1,
} from "../../../../../shared/drop/types";
import {
  isDropDeviceDelegation,
  serializeDropDeviceDelegationForSignature,
  toDropDeviceDelegationSignable,
  type DropDeviceDelegation,
} from "../../../../../shared/drop/deviceDelegation";

const textEncoder = new TextEncoder();

const fromBase64 = (value: string): Uint8Array => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

/** Returns whether two persisted P-256 signing keys represent the same key. */
export const sameDeviceSigningKey = (left: JsonWebKey, right: JsonWebKey): boolean =>
  left.kty === right.kty &&
  left.crv === right.crv &&
  left.x === right.x &&
  left.y === right.y;

/** Verifies a sealed envelope's device signature with the embedded signing key. */
export const verifyDropEnvelopeDeviceSignature = async (
  envelope: DropEnvelopeV1,
): Promise<boolean> => {
  if (!envelope.deviceSignerPublicJwk) return false;

  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      envelope.deviceSignerPublicJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      fromBase64(envelope.signatures.device.sig),
      textEncoder.encode(
        serializeDropEnvelopeForDeviceSignature(toDropEnvelopeSignable(envelope)),
      ),
    );
  } catch {
    return false;
  }
};

/** Verifies an account's canonical signature over a delegated device certificate. */
export const verifyDropDeviceDelegationSignature = async (
  delegation: DropDeviceDelegation,
  accountSigningPublicJwk: JsonWebKey,
): Promise<boolean> => {
  if (!isDropDeviceDelegation(delegation)) return false;

  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      accountSigningPublicJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      fromBase64(delegation.signature.sig),
      textEncoder.encode(
        serializeDropDeviceDelegationForSignature(
          toDropDeviceDelegationSignable(delegation),
        ),
      ),
    );
  } catch {
    return false;
  }
};

import {
  decodeDropDeviceDelegation,
  encodeDropDeviceDelegation,
} from "./device-delegation-v1";
import {
  serializeCanonicalJson,
  type DropCipherRecord,
  type DropDetachedSignature,
  type DropEnvelopeSignable,
  type DropEnvelope,
  type DropKeyEnvelope,
  type DropProviderEscrowEnvelope,
} from "../types";

/** Schema discriminator for sealed v1 drop envelopes. */
export const DROP_ENVELOPE_SCHEMA_V1 = "nmdn.drop.v1" as const;
/** Version discriminator for sealed v1 drop envelopes. */
export const DROP_ENVELOPE_VERSION_V1 = 1 as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isString = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isDropCipherRecord = (value: unknown): value is DropCipherRecord => {
  if (!isRecord(value)) return false;
  return (
    value.alg === "A256GCM" && isString(value.iv) && isString(value.ciphertext)
  );
};

const isDropKeyEnvelope = (value: unknown): value is DropKeyEnvelope => {
  if (!isRecord(value)) return false;
  return (
    value.mode === "account-vault-rsa-oaep" &&
    isString(value.kid) &&
    isString(value.wrappedKey)
  );
};

const isDropProviderEscrowEnvelope = (
  value: unknown,
): value is DropProviderEscrowEnvelope => {
  if (!isRecord(value)) return false;
  return (
    value.mode === "provider-rsa-oaep" &&
    isString(value.kid) &&
    isString(value.wrappedKey)
  );
};

const isDropDetachedSignature = (
  value: unknown,
): value is DropDetachedSignature => {
  if (!isRecord(value)) return false;
  return (
    isString(value.kid) &&
    value.alg === "ECDSA_P256_SHA256" &&
    isString(value.sig)
  );
};

type DropEnvelopeV1 = DropEnvelope & {
  schema: typeof DROP_ENVELOPE_SCHEMA_V1;
  version: typeof DROP_ENVELOPE_VERSION_V1;
};
type DropEnvelopeSignableV1 = DropEnvelopeSignable & {
  schema: typeof DROP_ENVELOPE_SCHEMA_V1;
  version: typeof DROP_ENVELOPE_VERSION_V1;
};

const isDropEnvelopeWire = (value: unknown): value is DropEnvelopeV1 => {
  if (!isRecord(value)) return false;

  if (value.schema !== DROP_ENVELOPE_SCHEMA_V1) return false;
  if (value.version !== DROP_ENVELOPE_VERSION_V1) return false;
  if (!isNumber(value.createdAt)) return false;
  if (!isString(value.accountId)) return false;
  if (
    value.visibility !== undefined &&
    value.visibility !== "private" &&
    value.visibility !== "unlisted" &&
    value.visibility !== "public"
  ) {
    return false;
  }

  if (
    value.unlockPolicy !== undefined &&
    value.unlockPolicy !== "vault-only" &&
    value.unlockPolicy !== "provider-escrow"
  ) {
    return false;
  }

  if (!isDropCipherRecord(value.cipher)) return false;
  if (
    value.draftCipher !== undefined &&
    !isDropCipherRecord(value.draftCipher)
  ) {
    return false;
  }
  if (!isDropKeyEnvelope(value.keyEnvelope)) return false;

  if (
    value.deviceSignerPublicJwk !== undefined &&
    !isRecord(value.deviceSignerPublicJwk)
  ) {
    return false;
  }

  if (
    value.deviceDelegation !== undefined &&
    !decodeDropDeviceDelegation(value.deviceDelegation)
  ) {
    return false;
  }

  if (
    value.providerEscrow !== undefined &&
    !isDropProviderEscrowEnvelope(value.providerEscrow)
  ) {
    return false;
  }

  if (value.metadata !== undefined && !isRecord(value.metadata)) {
    return false;
  }

  if (!isRecord(value.signatures)) return false;
  if (!isDropDetachedSignature(value.signatures.device)) return false;
  if (
    value.signatures.provider !== undefined &&
    !isDropDetachedSignature(value.signatures.provider)
  ) {
    return false;
  }

  return true;
};

/** Decodes a persisted V1 sealed envelope to the canonical envelope model. */
export const decodeDropEnvelope = (value: unknown): DropEnvelope | null => {
  if (!isDropEnvelopeWire(value)) return null;
  const deviceDelegation = value.deviceDelegation;
  const envelope: Partial<DropEnvelopeV1> = { ...value };
  delete envelope.schema;
  delete envelope.version;
  delete envelope.deviceDelegation;
  return {
    ...(envelope as DropEnvelope),
    ...(deviceDelegation === undefined
      ? {}
      : { deviceDelegation: decodeDropDeviceDelegation(deviceDelegation)! }),
  };
};

/** Encodes a canonical signable envelope body in its persisted V1 representation. */
const encodeDropEnvelopeSignable = (
  envelope: DropEnvelopeSignable,
): DropEnvelopeSignableV1 => ({
  schema: DROP_ENVELOPE_SCHEMA_V1,
  version: DROP_ENVELOPE_VERSION_V1,
  ...envelope,
  ...(envelope.deviceDelegation === undefined
    ? {}
    : { deviceDelegation: encodeDropDeviceDelegation(envelope.deviceDelegation) }),
});

/** Encodes a canonical envelope in its persisted V1 representation. */
export const encodeDropEnvelope = (
  envelope: DropEnvelope,
): DropEnvelopeV1 => ({
  schema: DROP_ENVELOPE_SCHEMA_V1,
  version: DROP_ENVELOPE_VERSION_V1,
  ...envelope,
  ...(envelope.deviceDelegation === undefined
    ? {}
    : { deviceDelegation: encodeDropDeviceDelegation(envelope.deviceDelegation) }),
});

/** Returns true when `value` is a structurally valid persisted V1 envelope. */
export const isDropEnvelope = (value: unknown): value is DropEnvelope =>
  decodeDropEnvelope(value) !== null;

/** Removes signatures from a complete canonical envelope to recover the device-signable body. */
export const toDropEnvelopeSignable = (
  envelope: DropEnvelope,
): DropEnvelopeSignable => ({
  createdAt: envelope.createdAt,
  accountId: envelope.accountId,
  visibility: envelope.visibility,
  unlockPolicy: envelope.unlockPolicy,
  metadata: envelope.metadata,
  cipher: envelope.cipher,
  draftCipher: envelope.draftCipher,
  keyEnvelope: envelope.keyEnvelope,
  deviceSignerPublicJwk: envelope.deviceSignerPublicJwk,
  deviceDelegation: envelope.deviceDelegation,
  providerEscrow: envelope.providerEscrow,
});

/** Serializes the exact canonical body that the device signs. */
export const serializeDropEnvelopeForDeviceSignature = (
  envelope: DropEnvelopeSignable,
): string => serializeCanonicalJson(encodeDropEnvelopeSignable(envelope));

/** Serializes the canonical body that the provider signs after device attestation. */
export const serializeDropEnvelopeForProviderSignature = (
  envelope: DropEnvelope,
): string =>
  serializeCanonicalJson({
    ...encodeDropEnvelopeSignable(toDropEnvelopeSignable(envelope)),
    signatures: {
      device: envelope.signatures.device,
    },
  });

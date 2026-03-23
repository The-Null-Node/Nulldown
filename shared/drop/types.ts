export const DROP_ENVELOPE_SCHEMA_V1 = "nmdn.drop.v1" as const;
export const DROP_ENVELOPE_VERSION_V1 = 1 as const;

export type DropSignatureAlgorithm = "ECDSA_P256_SHA256";
export type DropVisibility = "private" | "unlisted" | "public";
export type DropUnlockPolicy = "vault-only" | "provider-escrow";
export type DropDraftDiffPolicy = "edited-only" | "always";

export type DropDraftDiffOpType = "insert" | "delete";

export interface DropDraftDiffOp {
  type: DropDraftDiffOpType;
  start: number;
  end: number;
  text: string;
}

export interface DropDraftSnapshot {
  snapshotId: number;
  createdAt: number;
  fromLength: number;
  toLength: number;
  ops: DropDraftDiffOp[];
}

export interface DropDraftPackV1 {
  version: 1;
  policy: DropDraftDiffPolicy;
  source: "new-drop" | "edited-drop";
  createdAt: number;
  currentSnapshotId?: number;
  truncated?: boolean;
  snapshots: DropDraftSnapshot[];
}

export interface DropMetadata {
  themeId?: string;
  baseDropId?: string;
  snapshotId?: number;
  [key: string]: unknown;
}

export interface DropPayload {
  content: string;
  metadata?: DropMetadata;
  draftPack?: DropDraftPackV1;
}

export interface DropCipherRecord {
  alg: "A256GCM";
  iv: string;
  ciphertext: string;
}

export interface DropKeyEnvelope {
  mode: "account-vault-rsa-oaep";
  kid: string;
  wrappedKey: string;
}

export interface DropProviderEscrowEnvelope {
  mode: "provider-rsa-oaep";
  kid: string;
  wrappedKey: string;
}

export interface DropDetachedSignature {
  kid: string;
  alg: DropSignatureAlgorithm;
  sig: string;
}

export interface DropEnvelopeSignableV1 {
  schema: typeof DROP_ENVELOPE_SCHEMA_V1;
  version: typeof DROP_ENVELOPE_VERSION_V1;
  createdAt: number;
  accountId: string;
  visibility?: DropVisibility;
  unlockPolicy?: DropUnlockPolicy;
  metadata?: DropMetadata;
  cipher: DropCipherRecord;
  draftCipher?: DropCipherRecord;
  keyEnvelope: DropKeyEnvelope;
  deviceSignerPublicJwk?: JsonWebKey;
  providerEscrow?: DropProviderEscrowEnvelope;
}

export interface DropEnvelopeV1 extends DropEnvelopeSignableV1 {
  signatures: {
    device: DropDetachedSignature;
    provider?: DropDetachedSignature;
  };
}

export interface DropGraphNode {
  id: string;
  baseDropId: string | null;
}

export interface DropGraph {
  headId: string;
  rootId: string;
  lineage: string[];
  nodes: DropGraphNode[];
  builtAt: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isString = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isDropDraftDiffOp = (value: unknown): value is DropDraftDiffOp => {
  if (!isRecord(value)) return false;

  if (value.type !== "insert" && value.type !== "delete") {
    return false;
  }

  return (
    isNumber(value.start) &&
    isNumber(value.end) &&
    isString(value.text)
  );
};

const isDropDraftSnapshot = (value: unknown): value is DropDraftSnapshot => {
  if (!isRecord(value)) return false;

  if (
    !isNumber(value.snapshotId) ||
    !isNumber(value.createdAt) ||
    !isNumber(value.fromLength) ||
    !isNumber(value.toLength)
  ) {
    return false;
  }

  return (
    Array.isArray(value.ops) &&
    value.ops.every((operation) => isDropDraftDiffOp(operation))
  );
};

export const isDropDraftPackV1 = (value: unknown): value is DropDraftPackV1 => {
  if (!isRecord(value)) return false;

  if (value.version !== 1) return false;

  if (value.policy !== "edited-only" && value.policy !== "always") {
    return false;
  }

  if (value.source !== "new-drop" && value.source !== "edited-drop") {
    return false;
  }

  if (!isNumber(value.createdAt)) return false;

  if (
    value.currentSnapshotId !== undefined &&
    !isNumber(value.currentSnapshotId)
  ) {
    return false;
  }

  if (value.truncated !== undefined && typeof value.truncated !== "boolean") {
    return false;
  }

  return (
    Array.isArray(value.snapshots) &&
    value.snapshots.every((snapshot) => isDropDraftSnapshot(snapshot))
  );
};

export const isDropPayload = (value: unknown): value is DropPayload => {
  if (!isRecord(value)) return false;
  if (!isString(value.content)) return false;

  if (value.metadata !== undefined && !isRecord(value.metadata)) {
    return false;
  }

  if (value.draftPack !== undefined && !isDropDraftPackV1(value.draftPack)) {
    return false;
  }

  return true;
};

const isDropCipherRecord = (value: unknown): value is DropCipherRecord => {
  if (!isRecord(value)) return false;
  return (
    value.alg === "A256GCM" &&
    isString(value.iv) &&
    isString(value.ciphertext)
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

export const isDropEnvelopeV1 = (value: unknown): value is DropEnvelopeV1 => {
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
  if (value.draftCipher !== undefined && !isDropCipherRecord(value.draftCipher)) {
    return false;
  }
  if (!isDropKeyEnvelope(value.keyEnvelope)) return false;

  if (value.deviceSignerPublicJwk !== undefined && !isRecord(value.deviceSignerPublicJwk)) {
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

const normalizeForCanonicalJson = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForCanonicalJson(entry));
  }

  if (!isRecord(value)) {
    return value;
  }

  const keys = Object.keys(value).sort();
  const normalized: Record<string, unknown> = {};

  keys.forEach((key) => {
    normalized[key] = normalizeForCanonicalJson(value[key]);
  });

  return normalized;
};

export const serializeCanonicalJson = (value: unknown): string =>
  JSON.stringify(normalizeForCanonicalJson(value));

export const toDropEnvelopeSignable = (
  envelope: DropEnvelopeV1,
): DropEnvelopeSignableV1 => ({
  schema: envelope.schema,
  version: envelope.version,
  createdAt: envelope.createdAt,
  accountId: envelope.accountId,
  visibility: envelope.visibility,
  unlockPolicy: envelope.unlockPolicy,
  metadata: envelope.metadata,
  cipher: envelope.cipher,
  draftCipher: envelope.draftCipher,
  keyEnvelope: envelope.keyEnvelope,
  deviceSignerPublicJwk: envelope.deviceSignerPublicJwk,
  providerEscrow: envelope.providerEscrow,
});

export const serializeDropEnvelopeForDeviceSignature = (
  envelope: DropEnvelopeSignableV1,
): string => serializeCanonicalJson(envelope);

export const serializeDropEnvelopeForProviderSignature = (
  envelope: DropEnvelopeV1,
): string =>
  serializeCanonicalJson({
    ...toDropEnvelopeSignable(envelope),
    signatures: {
      device: envelope.signatures.device,
    },
  });

import {
  isDropDeviceDelegation,
  type DropDeviceDelegation,
} from "./deviceDelegation";

/*
This file is the canonical drop contract shared by the browser and Pages Functions.
Stored envelopes live in IndexedDB and R2, so compatibility changes here ripple through
encryption, syncing, unlock flows, and branch editing.
*/

/** Schema discriminator for sealed v1 drop envelopes. */
export const DROP_ENVELOPE_SCHEMA_V1 = "nmdn.drop.v1" as const;
/** Version discriminator for sealed v1 drop envelopes. */
export const DROP_ENVELOPE_VERSION_V1 = 1 as const;

/** Signature algorithm currently used by device and provider envelope signatures. */
export type DropSignatureAlgorithm = "ECDSA_P256_SHA256";
/** Share/index visibility for a stored drop. */
export type DropVisibility = "private" | "unlisted" | "public";
/** Unlock strategy for the encrypted content key. */
export type DropUnlockPolicy = "vault-only" | "provider-escrow";
/** Policy controlling whether draft edit history is packed into shared drops. */
export type DropDraftDiffPolicy = "edited-only" | "always";

/** JSON-safe draft-pack operation kind. */
export type DropDraftDiffOpType = "insert" | "delete";

/** Text operation stored inside a draft pack snapshot. */
export interface DropDraftDiffOp {
  /** Operation kind. */
  type: DropDraftDiffOpType;
  /** Inclusive source offset. */
  start: number;
  /** Exclusive source offset. */
  end: number;
  /** Inserted or deleted text payload. */
  text: string;
}

/** One captured editor snapshot inside a draft pack. */
export interface DropDraftSnapshot {
  /** Browser editor snapshot id. */
  snapshotId: number;
  /** Creation time in epoch milliseconds. */
  createdAt: number;
  /** Source length before the snapshot diff. */
  fromLength: number;
  /** Source length after the snapshot diff. */
  toLength: number;
  /** Operations needed to replay this draft snapshot. */
  ops: DropDraftDiffOp[];
}

/*
Draft packs let share/clone flows carry edit history forward without making the main
drop payload itself append-only. `source` distinguishes a brand-new share from an
edited existing drop because those flows are surfaced differently in the UI.
*/
export interface DropDraftPackV1 {
  /** Draft-pack schema version. */
  version: 1;
  /** Policy used when deciding whether to include this draft history. */
  policy: DropDraftDiffPolicy;
  /** Whether the packed history came from a new share or edited drop. */
  source: "new-drop" | "edited-drop";
  /** Creation time in epoch milliseconds. */
  createdAt: number;
  /** Current editor snapshot id when the pack was created. */
  currentSnapshotId?: number;
  /** True when older history was dropped to satisfy retention limits. */
  truncated?: boolean;
  /** Ordered retained snapshots. */
  snapshots: DropDraftSnapshot[];
}

/** Plain metadata stored with a drop payload and copied into sealed envelopes. */
export interface DropMetadata {
  /** Theme id to apply when rendering the drop. */
  themeId?: string;
  /** Parent drop id when this drop was edited or cloned from another drop. */
  baseDropId?: string;
  /** Root lineage id for branch-backed drops. */
  rootDropId?: string;
  /** Branch snapshot id used to create this drop. */
  snapshotId?: number;
  /** Network allowlist used by nullplug rendering. */
  allowedUrls?: string[];
  /** Additional feature-specific metadata. */
  [key: string]: unknown;
}

/** Plaintext drop payload before encryption or storage. */
export interface DropPayload {
  /** Markdown source content. */
  content: string;
  /** Optional render, lineage, privacy, and feature metadata. */
  metadata?: DropMetadata;
  /** Optional bounded draft history for edit/clone continuation. */
  draftPack?: DropDraftPackV1;
}

/** AES-GCM encrypted payload record stored inside a sealed envelope. */
export interface DropCipherRecord {
  /** Cipher suite identifier. */
  alg: "A256GCM";
  /** Base64url-encoded initialization vector. */
  iv: string;
  /** Base64url-encoded ciphertext. */
  ciphertext: string;
}

/** Content-key envelope wrapped to the account vault key. */
export interface DropKeyEnvelope {
  /** Key wrapping mode. */
  mode: "account-vault-rsa-oaep";
  /** Vault public key id. */
  kid: string;
  /** Wrapped content key. */
  wrappedKey: string;
}

/** Optional provider escrow copy of the content key. */
export interface DropProviderEscrowEnvelope {
  /** Provider key wrapping mode. */
  mode: "provider-rsa-oaep";
  /** Provider escrow public key id. */
  kid: string;
  /** Provider-wrapped content key. */
  wrappedKey: string;
}

/** Detached signature over canonical envelope payload bytes. */
export interface DropDetachedSignature {
  /** Signing key id. */
  kid: string;
  /** Signature algorithm. */
  alg: DropSignatureAlgorithm;
  /** Base64url-encoded signature bytes. */
  sig: string;
}

/*
This is the exact shape signed by the device key. Provider signatures are derived from
this payload plus the device signature so the server never signs content the device
did not already attest to.
*/
export interface DropEnvelopeSignable {
  /** Envelope schema discriminator. */
  schema: typeof DROP_ENVELOPE_SCHEMA_V1;
  /** Envelope version discriminator. */
  version: typeof DROP_ENVELOPE_VERSION_V1;
  /** Envelope creation time in epoch milliseconds. */
  createdAt: number;
  /** Account that sealed or owns the envelope. */
  accountId: string;
  /** Visibility requested for the stored drop. */
  visibility?: DropVisibility;
  /** Unlock mode for the sealed content key. */
  unlockPolicy?: DropUnlockPolicy;
  /** Plain envelope metadata used for routing, rendering, and lineage. */
  metadata?: DropMetadata;
  /** Encrypted primary payload. */
  cipher: DropCipherRecord;
  /** Optional encrypted draft-pack payload. */
  draftCipher?: DropCipherRecord;
  /** Account-vault wrapped content key. */
  keyEnvelope: DropKeyEnvelope;
  /** Public verification key for the device signature. */
  deviceSignerPublicJwk?: JsonWebKey;
  /** Account-signed authority for a delegated device signer. */
  deviceDelegation?: DropDeviceDelegation;
  /** Optional provider escrow wrapped content key. */
  providerEscrow?: DropProviderEscrowEnvelope;
}

/** Complete persisted sealed drop envelope. */
export interface DropEnvelopeV1 extends DropEnvelopeSignable {
  /** Required device signature and optional provider countersignature. */
  signatures: {
    /** Device signature over the canonical signable envelope. */
    device: DropDetachedSignature;
    /** Provider signature over the signable envelope plus device signature. */
    provider?: DropDetachedSignature;
  };
}

/*
Lineage is stored as `baseDropId` pointers on payload metadata. The graph here is a
materialized view built on demand so callers can reason about clone ancestry without
hard-coding traversal rules.
*/
export interface DropGraphNode {
  /** Drop id represented by this graph node. */
  id: string;
  /** Parent/base drop id, or null for the root. */
  baseDropId: string | null;
}

/** Materialized lineage graph for a drop and its ancestors. */
export interface DropGraph {
  /** Requested head drop id. */
  headId: string;
  /** Oldest/root drop id discovered from lineage. */
  rootId: string;
  /** Ordered lineage from root to head. */
  lineage: string[];
  /** Node table for lineage display and traversal. */
  nodes: DropGraphNode[];
  /** Graph materialization time in epoch milliseconds. */
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

  return isNumber(value.start) && isNumber(value.end) && isString(value.text);
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

/** Returns true when `value` is a valid v1 draft pack. */
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

/** Returns true when `value` is a valid plaintext drop payload. */
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

/** Returns true when `value` is a structurally valid sealed v1 envelope. */
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
    !isDropDeviceDelegation(value.deviceDelegation)
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

/*
Signatures and conflict detection depend on deterministic JSON ordering. Do not swap
this serializer for plain `JSON.stringify` in any code path that compares envelopes.
*/
export const serializeCanonicalJson = (value: unknown): string =>
  JSON.stringify(normalizeForCanonicalJson(value));

/** Removes signatures from a complete envelope to recover the device-signable body. */
export const toDropEnvelopeSignable = (
  envelope: DropEnvelopeV1,
): DropEnvelopeSignable => ({
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
  deviceDelegation: envelope.deviceDelegation,
  providerEscrow: envelope.providerEscrow,
});

/** Serializes the exact canonical body that the device signs. */
export const serializeDropEnvelopeForDeviceSignature = (
  envelope: DropEnvelopeSignable,
): string => serializeCanonicalJson(envelope);

/** Serializes the canonical body that the provider signs after device attestation. */
export const serializeDropEnvelopeForProviderSignature = (
  envelope: DropEnvelopeV1,
): string =>
  serializeCanonicalJson({
    ...toDropEnvelopeSignable(envelope),
    signatures: {
      device: envelope.signatures.device,
    },
  });

import type { DropDeviceDelegation } from "./deviceDelegation";

/*
This file is the canonical drop contract shared by the browser and Pages Functions.
Stored envelopes live in IndexedDB and R2, so compatibility changes here ripple through
encryption, syncing, unlock flows, and branch editing.
*/

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
export interface DropDraftPack {
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
  draftPack?: DropDraftPack;
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
export interface DropEnvelope extends DropEnvelopeSignable {
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

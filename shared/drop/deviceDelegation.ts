import type { DropDetachedSignature } from "./types";

/** Account-signed authority for a non-browser device to author account drops. */
export interface DropDeviceDelegation {
  accountId: string;
  credentialId: string;
  delegateSigningPublicJwk: JsonWebKey;
  encryptionKid: string;
  encryptionPublicJwk: JsonWebKey;
  issuedAt: number;
  expiresAt: number;
  signature: DropDetachedSignature;
}

/** Delegation body signed by the account's pinned signing key. */
export interface DropDeviceDelegationSignable {
  accountId: string;
  credentialId: string;
  delegateSigningPublicJwk: JsonWebKey;
  encryptionKid: string;
  encryptionPublicJwk: JsonWebKey;
  issuedAt: number;
  expiresAt: number;
}

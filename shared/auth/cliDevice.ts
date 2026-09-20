import type { DropDeviceDelegation } from "../drop/deviceDelegation";

/** Public RSA key used to encrypt the one-time CLI credential response. */
export interface CliEncryptionPublicJwk {
  kty: "RSA";
  n: string;
  e: string;
  alg?: string;
  ext?: boolean;
  key_ops?: string[];
}

/** Local delegated authoring material persisted only in the CLI auth file. */
export interface CliDeviceAuthoring {
  signingKid: string;
  signingPublicJwk: JsonWebKey;
  signingPrivateJwk: JsonWebKey;
  deviceDelegation: DropDeviceDelegation;
}

/** Request sent by a CLI before a browser approval can begin. */
export interface CliDeviceStartRequest {
  publicKey: CliEncryptionPublicJwk;
  clientName?: string;
}

/** Public information shown to the CLI operator during authorization. */
export interface CliDeviceStartResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  interval: number;
}

/** Request sent by the browser after the user approves an account. */
export interface CliDeviceApprovalRequest {
  userCode: string;
  accountId: string;
}

/** Request sent by the CLI while waiting for browser approval. */
export interface CliDevicePollRequest {
  deviceCode: string;
}

/** Encrypted one-time credential returned after browser approval. */
export interface CliCredentialEnvelope {
  wrappedKey: string;
  iv: string;
  ciphertext: string;
}

/** Refreshable credential bundle decrypted only by the requesting CLI. */
export interface CliCredentialBundle {
  baseUrl: string;
  userId: string;
  accountId: string;
  credentialId: string;
  refreshToken: string;
  accessToken: string;
  accessExpiresAt: number;
  credentialExpiresAt: number;
  createdAt: number;
  authoring?: CliDeviceAuthoring;
}

export type CliDevicePollResponse =
  | { status: "pending"; interval: number }
  | { status: "approved"; envelope: CliCredentialEnvelope }
  | { status: "expired" };

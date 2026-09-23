/** Private account material that exists only before encryption or after local decryption. */
export interface AccountRecoveryPayload {
  accountId: string;
  encryptionKid: string;
  signingKid: string;
  encryptionPublicJwk: JsonWebKey;
  encryptionPrivateJwk: JsonWebKey;
  signingPublicJwk: JsonWebKey;
  signingPrivateJwk: JsonWebKey;
  createdAt: number;
}

/** Server-visible authenticated metadata for one encrypted recovery package. */
export interface AccountRecoveryPackageMetadata {
  userId: string;
  accountId: string;
  revision: number;
  encryptionKid: string;
  signingKid: string;
  signingKeyFingerprint: string;
  kdf: "HKDF-SHA-256";
  salt: string;
  aead: "A256GCM";
  iv: string;
  ciphertextDigest: string;
  ciphertextLength: number;
}

/** Upload/download representation. Ciphertext is opaque to server application code. */
export interface EncryptedAccountRecoveryPackage {
  metadata: AccountRecoveryPackageMetadata;
  ciphertext: string;
}

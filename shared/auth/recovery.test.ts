import {
  ACCOUNT_RECOVERY_PACKAGE_SCHEMA_V1,
  parseEncryptedAccountRecoveryPackage,
  parseAccountRecoveryPackageMetadata,
  serializeAccountRecoveryPackage,
  type AccountRecoveryPackageMetadataV1,
} from "./recovery";

const metadata: AccountRecoveryPackageMetadataV1 = {
  schema: ACCOUNT_RECOVERY_PACKAGE_SCHEMA_V1,
  version: 1,
  userId: "user_01",
  accountId: "account-01",
  revision: 1,
  encryptionKid: "enc_01",
  signingKid: "sig_01",
  signingKeyFingerprint: `sha256:${"a".repeat(43)}`,
  kdf: "HKDF-SHA-256",
  salt: "b".repeat(22),
  aead: "A256GCM",
  iv: "c".repeat(16),
  ciphertextDigest: `sha256:${"d".repeat(43)}`,
  ciphertextLength: 24,
};

describe("account-recovery package contract", () => {
  it("accepts only the bounded server-visible metadata shape", () => {
    expect(parseAccountRecoveryPackageMetadata(metadata)).toEqual(metadata);
    expect(parseAccountRecoveryPackageMetadata({ ...metadata, signingPrivateJwk: {} })).toBeNull();
    expect(parseAccountRecoveryPackageMetadata({ ...metadata, revision: 0 })).toBeNull();
    expect(parseAccountRecoveryPackageMetadata({ ...metadata, ciphertextLength: 70_000 })).toBeNull();
  });

  it("rejects uploads whose encoded ciphertext length disagrees with metadata", () => {
    expect(
      parseEncryptedAccountRecoveryPackage({ metadata, ciphertext: "e".repeat(32) }),
    ).toEqual({ metadata, ciphertext: "e".repeat(32) });
    expect(
      parseEncryptedAccountRecoveryPackage({
        metadata: { ...metadata, ciphertextLength: 10 },
        ciphertext: "e".repeat(32),
      }),
    ).toBeNull();
  });

  it("signs every package field through one canonical serialization", () => {
    const encryptedPackage = { metadata, ciphertext: "e".repeat(32) };
    const serialized = serializeAccountRecoveryPackage(encryptedPackage);

    expect(serialized).toContain(metadata.ciphertextDigest);
    expect(serialized).toContain(encryptedPackage.ciphertext);
    expect(
      serializeAccountRecoveryPackage({
        ...encryptedPackage,
        ciphertext: `${encryptedPackage.ciphertext.slice(0, -1)}f`,
      }),
    ).not.toBe(serialized);
  });
});

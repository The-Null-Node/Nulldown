import {
  decodeAccountRecoveryPackageMetadata,
  decodeAccountRecoveryPayload,
  decodeEncryptedAccountRecoveryPackage,
  encodeAccountRecoveryPayload,
  encodeAccountRecoveryPackageMetadata,
  encodeEncryptedAccountRecoveryPackage,
  serializeAccountRecoveryPackageAad,
  serializeAccountRecoveryPackage,
} from "./codecs/account-recovery-v1";
import { ACCOUNT_RECOVERY_PACKAGE_SCHEMA_V1 } from "./codecs/account-recovery-v1";
import type {
  AccountRecoveryPackageMetadata,
  AccountRecoveryPayload,
} from "./recovery";

const metadata: AccountRecoveryPackageMetadata = {
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
    const encoded = encodeAccountRecoveryPackageMetadata(metadata);
    expect(decodeAccountRecoveryPackageMetadata(encoded)).toEqual(metadata);
    expect(
      decodeAccountRecoveryPackageMetadata({
        ...encoded,
        signingPrivateJwk: {},
      }),
    ).toBeNull();
    expect(
      decodeAccountRecoveryPackageMetadata({ ...encoded, revision: 0 }),
    ).toBeNull();
    expect(
      decodeAccountRecoveryPackageMetadata({
        ...encoded,
        ciphertextLength: 70_000,
      }),
    ).toBeNull();
  });

  it("rejects uploads whose encoded ciphertext length disagrees with metadata", () => {
    const encoded = encodeAccountRecoveryPackageMetadata(metadata);
    expect(
      decodeEncryptedAccountRecoveryPackage({
        metadata: encoded,
        ciphertext: "e".repeat(32),
      }),
    ).toEqual({ metadata, ciphertext: "e".repeat(32) });
    expect(
      decodeEncryptedAccountRecoveryPackage({
        metadata: { ...encoded, ciphertextLength: 10 },
        ciphertext: "e".repeat(32),
      }),
    ).toBeNull();
  });

  it("signs every package field through one canonical serialization", () => {
    const encryptedPackage = { metadata, ciphertext: "e".repeat(32) };
    const encoded = encodeEncryptedAccountRecoveryPackage(encryptedPackage);
    const parsed = decodeEncryptedAccountRecoveryPackage(encoded);
    if (!parsed) throw new Error("Expected valid recovery fixture.");
    const serialized = serializeAccountRecoveryPackage(parsed);

    expect(serialized).toBe(
      [
        ACCOUNT_RECOVERY_PACKAGE_SCHEMA_V1,
        "1",
        metadata.userId,
        metadata.accountId,
        "1",
        metadata.encryptionKid,
        metadata.signingKid,
        metadata.signingKeyFingerprint,
        metadata.kdf,
        metadata.salt,
        metadata.aead,
        metadata.iv,
        metadata.ciphertextDigest,
        "24",
        encryptedPackage.ciphertext,
      ].join("\n"),
    );
    expect(serializeAccountRecoveryPackage(encryptedPackage)).toBe(serialized);
    expect(
      serializeAccountRecoveryPackage({
        ...encryptedPackage,
        ciphertext: `${encryptedPackage.ciphertext.slice(0, -1)}f`,
      }),
    ).not.toBe(serialized);
    expect(serializeAccountRecoveryPackageAad(metadata)).toBe(
      [
        ACCOUNT_RECOVERY_PACKAGE_SCHEMA_V1,
        "1",
        metadata.userId,
        metadata.accountId,
        "1",
        metadata.encryptionKid,
        metadata.signingKid,
        metadata.signingKeyFingerprint,
        metadata.kdf,
        metadata.salt,
        metadata.aead,
        metadata.iv,
      ].join("\n"),
    );
  });

  it("round-trips the persisted recovery package without retaining schema fields", () => {
    const raw = JSON.stringify(
      encodeEncryptedAccountRecoveryPackage({
        metadata,
        ciphertext: "e".repeat(32),
      }),
    );
    const decoded = decodeEncryptedAccountRecoveryPackage(JSON.parse(raw));

    expect(decoded).toEqual({ metadata, ciphertext: "e".repeat(32) });
    expect(decoded?.metadata).not.toHaveProperty("schema");
    expect(JSON.stringify(encodeEncryptedAccountRecoveryPackage(decoded!))).toBe(
      raw,
    );
  });

  it("round-trips private recovery payloads without exposing wire fields", () => {
    const payload: AccountRecoveryPayload = {
      accountId: "account-01",
      encryptionKid: "enc_01",
      signingKid: "sig_01",
      encryptionPublicJwk: { kty: "RSA", n: "n", e: "AQAB" },
      encryptionPrivateJwk: {
        kty: "RSA",
        n: "n",
        e: "AQAB",
        d: "d",
        p: "p",
        q: "q",
        dp: "dp",
        dq: "dq",
        qi: "qi",
      },
      signingPublicJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
      signingPrivateJwk: {
        kty: "EC",
        crv: "P-256",
        x: "x",
        y: "y",
        d: "d",
      },
      createdAt: 1,
    };
    const raw = JSON.stringify(encodeAccountRecoveryPayload(payload));
    const decoded = decodeAccountRecoveryPayload(JSON.parse(raw));

    expect(decoded).toEqual(payload);
    expect(decoded).not.toHaveProperty("schema");
    expect(JSON.stringify(encodeAccountRecoveryPayload(decoded!))).toBe(raw);
  });
});

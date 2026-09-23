import {
  encodeEncryptedAccountRecoveryPackage,
} from "../../../../../shared/auth/codecs/account-recovery-v1";
import type { AccountRecoveryPayload } from "../../../../../shared/auth/recovery";
import {
  decryptAccountRecoveryPackage,
  encryptAccountRecoveryPayload,
} from "./crypto";

const createPayload = async (): Promise<AccountRecoveryPayload> => {
  const [rsa, ec] = (await Promise.all([
    crypto.subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["encrypt", "decrypt"],
    ),
    crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    ),
  ])) as [CryptoKeyPair, CryptoKeyPair];
  return {
    accountId: "account-01",
    encryptionKid: "enc_01",
    signingKid: "sig_01",
    encryptionPublicJwk: await crypto.subtle.exportKey("jwk", rsa.publicKey),
    encryptionPrivateJwk: await crypto.subtle.exportKey("jwk", rsa.privateKey),
    signingPublicJwk: await crypto.subtle.exportKey("jwk", ec.publicKey),
    signingPrivateJwk: await crypto.subtle.exportKey("jwk", ec.privateKey),
    createdAt: 1_000,
  };
};

describe("browser account recovery crypto", () => {
  it("round-trips legacy V1 account keys through canonical recovery data", async () => {
    const payload = await createPayload();
    const encrypted = await encryptAccountRecoveryPayload({
      payload,
      userId: "user_01",
      revision: 1,
    });

    await expect(
      decryptAccountRecoveryPackage(
        encodeEncryptedAccountRecoveryPackage(encrypted.package),
        encrypted.recoveryCode,
      ),
    ).resolves.toEqual(payload);
    expect(JSON.stringify(encrypted.package)).not.toContain("PrivateJwk");
    expect(JSON.stringify(encrypted.package)).not.toContain('"d"');
    expect(encrypted.package.metadata).not.toHaveProperty("schema");
    expect(encodeEncryptedAccountRecoveryPackage(encrypted.package).metadata).toMatchObject({
      schema: "nulldown.account-recovery-package.v1",
      version: 1,
    });
  });

  it("rejects the wrong recovery code and authenticated metadata tampering", async () => {
    const encrypted = await encryptAccountRecoveryPayload({
      payload: await createPayload(),
      userId: "user_01",
      revision: 1,
    });
    const wrongCode = "A".repeat(43);
    await expect(
      decryptAccountRecoveryPackage(
        encodeEncryptedAccountRecoveryPackage(encrypted.package),
        wrongCode,
      ),
    ).rejects.toThrow("Recovery code or package is invalid");
    await expect(
      decryptAccountRecoveryPackage(
        encodeEncryptedAccountRecoveryPackage({
          ...encrypted.package,
          metadata: { ...encrypted.package.metadata, userId: "user_02" },
        }),
        encrypted.recoveryCode,
      ),
    ).rejects.toThrow("Recovery code or package is invalid");
  });
});

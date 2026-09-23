import { webcrypto } from "node:crypto";
import {
  sealDropForAuthoring,
  type AccountEncryptionMaterial,
  type DelegateSigningMaterial,
} from "./authoring-crypto";
import {
  serializeDropDeviceDelegationForSignature,
  toDropDeviceDelegationSignable,
} from "./codecs/device-delegation-v1";
import type { DropDeviceDelegation } from "./device-delegation";
import {
  serializeDropEnvelopeForDeviceSignature,
  toDropEnvelopeSignable,
} from "./codecs/envelope-v1";

const toBase64 = (value: ArrayBuffer): string =>
  Buffer.from(value).toString("base64");

describe("authoring crypto", () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, "crypto", {
      value: webcrypto,
      configurable: true,
    });
  });

  it("seals a delegated envelope that verifies with the account and device keys", async () => {
    const [accountEncryptionPair, accountSigningPair, delegateSigningPair] =
      (await Promise.all([
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
        crypto.subtle.generateKey(
          { name: "ECDSA", namedCurve: "P-256" },
          true,
          ["sign", "verify"],
        ),
      ])) as [CryptoKeyPair, CryptoKeyPair, CryptoKeyPair];
    const [encryptionPublicJwk, delegateSigningPublicJwk] = await Promise.all([
      crypto.subtle.exportKey("jwk", accountEncryptionPair.publicKey),
      crypto.subtle.exportKey("jwk", delegateSigningPair.publicKey),
    ]);
    const unsignedDelegation = {
      accountId: "account-1",
      credentialId: "credential-1",
      delegateSigningPublicJwk,
      encryptionKid: "enc-1",
      encryptionPublicJwk,
      issuedAt: 100,
      expiresAt: 200,
    };
    const rootSignature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      accountSigningPair.privateKey,
      new TextEncoder().encode(
        serializeDropDeviceDelegationForSignature(unsignedDelegation),
      ),
    );
    const deviceDelegation: DropDeviceDelegation = {
      ...unsignedDelegation,
      signature: {
        kid: "account-signing-key",
        alg: "ECDSA_P256_SHA256",
        sig: toBase64(rootSignature),
      },
    };
    const accountEncryption: AccountEncryptionMaterial = {
      accountId: "account-1",
      encryptionKid: "enc-1",
      encryptionPublicJwk,
      encryptionPublicKey: accountEncryptionPair.publicKey,
    };
    const delegateSigning: DelegateSigningMaterial = {
      signingKid: "delegate-signing-key",
      signingPublicJwk: delegateSigningPublicJwk,
      signingPrivateKey: delegateSigningPair.privateKey,
      deviceDelegation,
    };

    const envelope = await sealDropForAuthoring({
      payload: { content: "account-owned content" },
      accountEncryption,
      delegateSigning,
      visibility: "private",
      unlockPolicy: "vault-only",
      createdAt: 150,
    });
    const rootValid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      accountSigningPair.publicKey,
      Buffer.from(deviceDelegation.signature.sig, "base64"),
      new TextEncoder().encode(
        serializeDropDeviceDelegationForSignature(
          toDropDeviceDelegationSignable(deviceDelegation),
        ),
      ),
    );
    const deviceValid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      delegateSigningPair.publicKey,
      Buffer.from(envelope.signatures.device.sig, "base64"),
      new TextEncoder().encode(
        serializeDropEnvelopeForDeviceSignature(
          toDropEnvelopeSignable(envelope),
        ),
      ),
    );

    expect(envelope.deviceDelegation).toEqual(deviceDelegation);
    expect(rootValid).toBe(true);
    expect(deviceValid).toBe(true);
    expect(
      serializeDropEnvelopeForDeviceSignature(toDropEnvelopeSignable(envelope)),
    ).toContain('"deviceDelegation"');
    expect(
      envelope.deviceDelegation?.delegateSigningPublicJwk,
    ).not.toHaveProperty("d");
  });

  it("rejects a certificate that is not bound to the account encryption material", async () => {
    const delegation: DropDeviceDelegation = {
      accountId: "other-account",
      credentialId: "credential-1",
      delegateSigningPublicJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
      encryptionKid: "enc-1",
      encryptionPublicJwk: { kty: "RSA", n: "n", e: "AQAB" },
      issuedAt: 100,
      expiresAt: 200,
      signature: { kid: "account-key", alg: "ECDSA_P256_SHA256", sig: "sig" },
    };

    await expect(
      sealDropForAuthoring({
        payload: { content: "content" },
        accountEncryption: {
          accountId: "account-1",
          encryptionKid: "enc-1",
          encryptionPublicJwk: delegation.encryptionPublicJwk,
          encryptionPublicKey: {} as CryptoKey,
        },
        delegateSigning: {
          signingKid: "delegate-key",
          signingPublicJwk: delegation.delegateSigningPublicJwk,
          signingPrivateKey: {} as CryptoKey,
          deviceDelegation: delegation,
        },
        visibility: "private",
        unlockPolicy: "vault-only",
      }),
    ).rejects.toThrow(
      "Device delegation does not match the authoring material.",
    );
  });
});

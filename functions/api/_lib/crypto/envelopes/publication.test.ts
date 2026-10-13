import { createPromotedEnvelope } from "./promotion";
import { sealPublishedEnvelope } from "./publication";
import { decryptProviderEscrowEnvelope } from "./provider-escrow";
import { verifyDropEnvelopeDeviceSignature } from "./verification";

it.each(["private", "public", "unlisted"] as const)(
  "preserves %s visibility and key recipients when publishing",
  async (visibility) => {
    const encryption = await crypto.subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["encrypt", "decrypt"],
    );
    const signing = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const encryptionKey = JSON.stringify(
      await crypto.subtle.exportKey(
        "jwk",
        (encryption as CryptoKeyPair).privateKey,
      ),
    );
    const signingKey = JSON.stringify(
      await crypto.subtle.exportKey(
        "jwk",
        (signing as CryptoKeyPair).privateKey,
      ),
    );
    const original = await createPromotedEnvelope({
      content: "original",
      accountId: "owner",
      metadata: {},
      providerEncryptionPrivateJwk: encryptionKey,
      providerSigningPrivateJwk: signingKey,
    });
    original.visibility = visibility;
    const updated = await sealPublishedEnvelope(
      original,
      "published",
      { themeId: "system" },
      encryptionKey,
      signingKey,
    );
    expect(updated.visibility).toBe(visibility);
    expect(updated.accountId).toBe(original.accountId);
    expect(updated.createdAt).toBe(original.createdAt);
    expect(updated.keyEnvelope).toEqual(original.keyEnvelope);
    expect(updated.providerEscrow).toEqual(original.providerEscrow);
    expect(updated.cipher.iv).not.toBe(original.cipher.iv);
    expect(
      await decryptProviderEscrowEnvelope(updated, encryptionKey),
    ).toMatchObject({ content: "published" });
    expect(await verifyDropEnvelopeDeviceSignature(updated)).toBe(true);
    expect(updated.signatures.provider).toBeDefined();
  },
);

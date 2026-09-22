import {
  onRequestGet as recoveryGetRoute,
  onRequestPut as recoveryPutRoute,
} from "../../../account/recovery";
import type {
  AccountRecoveryPayload,
  EncryptedAccountRecoveryPackage,
} from "../../../../../shared/auth/recovery";
import {
  encodeEncryptedAccountRecoveryPackage,
  serializeAccountRecoveryPackage,
} from "../../../../../shared/auth/codecs/account-recovery-v1";
import { encryptAccountRecoveryPayload } from "../../../../../src/lib/auth/vault/recovery/crypto";
import {
  accessCookieName,
  bindHarnessAccount,
  createHarness,
  origin,
  requestContext,
  toBase64Url,
} from "../testing/key-exchange-fixture";

const createRecoveryPayload = async (
  harness: Awaited<ReturnType<typeof createHarness>>,
): Promise<AccountRecoveryPayload> => {
  const encryptionPair = (await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKeyPair;
  return {
    accountId: harness.accountId,
    encryptionKid: "enc_01",
    signingKid: "sig_01",
    encryptionPublicJwk: await crypto.subtle.exportKey(
      "jwk",
      encryptionPair.publicKey,
    ),
    encryptionPrivateJwk: await crypto.subtle.exportKey(
      "jwk",
      encryptionPair.privateKey,
    ),
    signingPublicJwk: harness.signingPublicJwk,
    signingPrivateJwk: await crypto.subtle.exportKey(
      "jwk",
      harness.signingPair.privateKey,
    ),
    createdAt: 1_000,
  };
};

const signedRecoveryUpload = async (
  harness: Awaited<ReturnType<typeof createHarness>>,
  encryptedPackage: EncryptedAccountRecoveryPackage,
  privateKey = harness.signingPair.privateKey,
) => {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(serializeAccountRecoveryPackage(encryptedPackage)),
  );
  return {
    package: encodeEncryptedAccountRecoveryPackage(encryptedPackage),
    signature: toBase64Url(new Uint8Array(signature)),
  };
};

describe("account recovery Pages contracts", () => {
  it("stores only ciphertext and lets only the owning OpenAuth user retrieve it", async () => {
    const harness = await createHarness();
    expect((await bindHarnessAccount(harness)).bindResponse.status).toBe(201);
    const encrypted = await encryptAccountRecoveryPayload({
      payload: await createRecoveryPayload(harness),
      userId: "user_01",
      revision: 1,
    });
    const put = await recoveryPutRoute(
      requestContext(
        new Request(`${origin}/api/account/recovery`, {
          method: "PUT",
          headers: { ...harness.headers, "Content-Type": "application/json" },
          body: JSON.stringify(
            await signedRecoveryUpload(harness, encrypted.package),
          ),
        }),
        harness.env,
      ),
    );
    expect(put.status).toBe(201);
    const storedBody = [...harness.bucket.objects.values()].join("\n");
    expect(storedBody).not.toContain("signingPrivateJwk");
    expect(storedBody).not.toContain("encryptionPrivateJwk");

    const get = await recoveryGetRoute(
      requestContext(
        new Request(`${origin}/api/account/recovery`, {
          headers: { Cookie: harness.headers.Cookie },
        }),
        harness.env,
      ),
    );
    expect(get.status).toBe(200);
    await expect(get.json()).resolves.toEqual({
      available: true,
      package: encodeEncryptedAccountRecoveryPackage(encrypted.package),
    });
    expect(
      harness.database.packages.get(harness.accountId)?.metadata_json,
    ).toBe(
      JSON.stringify(
        encodeEncryptedAccountRecoveryPackage(encrypted.package).metadata,
      ),
    );

    harness.database.users.add("user_02");
    const otherAccess = await harness.authority.token("user_02");
    const denied = await recoveryGetRoute(
      requestContext(
        new Request(`${origin}/api/account/recovery`, {
          headers: { Cookie: `${accessCookieName}=${otherAccess}` },
        }),
        harness.env,
      ),
    );
    expect(denied.status).toBe(404);

    const tamperedCiphertext = `${
      encrypted.package.ciphertext.startsWith("A") ? "B" : "A"
    }${encrypted.package.ciphertext.slice(1)}`;
    const tampered = await recoveryPutRoute(
      requestContext(
        new Request(`${origin}/api/account/recovery`, {
          method: "PUT",
          headers: { ...harness.headers, "Content-Type": "application/json" },
          body: JSON.stringify(
            await signedRecoveryUpload(harness, {
              ...encrypted.package,
              ciphertext: tamperedCiphertext,
            }),
          ),
        }),
        harness.env,
      ),
    );
    expect(tampered.status).toBe(400);

    const stalePackage = await encryptAccountRecoveryPayload({
      payload: await createRecoveryPayload(harness),
      userId: "user_01",
      revision: 1,
    });
    const stale = await recoveryPutRoute(
      requestContext(
        new Request(`${origin}/api/account/recovery`, {
          method: "PUT",
          headers: { ...harness.headers, "Content-Type": "application/json" },
          body: JSON.stringify(
            await signedRecoveryUpload(harness, stalePackage.package),
          ),
        }),
        harness.env,
      ),
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({
      error: "recovery_revision_conflict",
      currentRevision: 1,
    });

    const rotatedPackage = await encryptAccountRecoveryPayload({
      payload: await createRecoveryPayload(harness),
      userId: "user_01",
      revision: 2,
    });
    const attacker = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const forgedRotation = await recoveryPutRoute(
      requestContext(
        new Request(`${origin}/api/account/recovery`, {
          method: "PUT",
          headers: { ...harness.headers, "Content-Type": "application/json" },
          body: JSON.stringify(
            await signedRecoveryUpload(
              harness,
              rotatedPackage.package,
              attacker.privateKey,
            ),
          ),
        }),
        harness.env,
      ),
    );
    expect(forgedRotation.status).toBe(401);
    expect(harness.database.packages.get(harness.accountId)?.revision).toBe(1);

    const rotated = await recoveryPutRoute(
      requestContext(
        new Request(`${origin}/api/account/recovery`, {
          method: "PUT",
          headers: { ...harness.headers, "Content-Type": "application/json" },
          body: JSON.stringify(
            await signedRecoveryUpload(harness, rotatedPackage.package),
          ),
        }),
        harness.env,
      ),
    );
    expect(rotated.status).toBe(201);
    expect(harness.database.packages.get(harness.accountId)?.revision).toBe(2);
  });
});

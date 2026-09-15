import {
  ACCOUNT_RECOVERY_PACKAGE_SCHEMA_V1,
  parseAccountRecoveryPayload,
  parseEncryptedAccountRecoveryPackage,
  serializeAccountRecoveryPackageAad,
  type AccountRecoveryPackageMetadataV1,
  type AccountRecoveryPayloadV1,
  type EncryptedAccountRecoveryPackageV1,
} from "../../../../../shared/auth/recovery";

const RECOVERY_INFO = "nulldown.account-recovery-key.v1";

const encodeText = (value: string): Uint8Array => new TextEncoder().encode(value);
const decodeText = (value: ArrayBuffer): string => new TextDecoder().decode(value);

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const fromBase64Url = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new TypeError("Invalid recovery encoding.");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const hash = async (value: string): Promise<string> =>
  `sha256:${toBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encodeText(value))),
  )}`;

export const fingerprintRecoverySigningKey = (jwk: JsonWebKey): Promise<string> =>
  hash(JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }));

const deriveRecoveryKey = async (
  recoveryCode: string,
  salt: Uint8Array,
  userId: string,
  accountId: string,
): Promise<CryptoKey> => {
  const secret = fromBase64Url(recoveryCode);
  if (secret.byteLength !== 32) throw new TypeError("Recovery code is invalid.");
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: encodeText(`${RECOVERY_INFO}\n${userId}\n${accountId}`),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
};

/** Generates the high-entropy code shown once during sync setup. */
export const createAccountRecoveryCode = (): string =>
  toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

/** Encrypts the complete current V1 account payload without exposing it to the service. */
export const encryptAccountRecoveryPayload = async (input: Readonly<{
  payload: AccountRecoveryPayloadV1;
  userId: string;
  revision: number;
  recoveryCode?: string;
}>): Promise<{ recoveryCode: string; package: EncryptedAccountRecoveryPackageV1 }> => {
  const payload = parseAccountRecoveryPayload(input.payload);
  if (!payload) throw new TypeError("Recovery payload is invalid.");
  const recoveryCode = input.recoveryCode ?? createAccountRecoveryCode();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const signingKeyFingerprint = await fingerprintRecoverySigningKey(payload.signingPublicJwk);
  const metadataWithoutCiphertext: AccountRecoveryPackageMetadataV1 = {
    schema: ACCOUNT_RECOVERY_PACKAGE_SCHEMA_V1,
    version: 1,
    userId: input.userId,
    accountId: payload.accountId,
    revision: input.revision,
    encryptionKid: payload.encryptionKid,
    signingKid: payload.signingKid,
    signingKeyFingerprint,
    kdf: "HKDF-SHA-256",
    salt: toBase64Url(salt),
    aead: "A256GCM",
    iv: toBase64Url(iv),
    ciphertextDigest: `sha256:${"A".repeat(43)}`,
    ciphertextLength: 1,
  };
  const key = await deriveRecoveryKey(recoveryCode, salt, input.userId, payload.accountId);
  const ciphertextBytes = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: encodeText(
          serializeAccountRecoveryPackageAad(metadataWithoutCiphertext),
        ),
      },
      key,
      encodeText(JSON.stringify(payload)),
    ),
  );
  const ciphertext = toBase64Url(ciphertextBytes);
  return {
    recoveryCode,
    package: {
      metadata: {
        ...metadataWithoutCiphertext,
        ciphertextDigest: await hash(ciphertext),
        ciphertextLength: ciphertextBytes.byteLength,
      },
      ciphertext,
    },
  };
};

const verifyRecoveredKeyPairs = async (payload: AccountRecoveryPayloadV1): Promise<void> => {
  const [rsaPublic, rsaPrivate, signingPublic, signingPrivate] = await Promise.all([
    crypto.subtle.importKey(
      "jwk",
      payload.encryptionPublicJwk,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    ),
    crypto.subtle.importKey(
      "jwk",
      payload.encryptionPrivateJwk,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["decrypt"],
    ),
    crypto.subtle.importKey(
      "jwk",
      payload.signingPublicJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    ),
    crypto.subtle.importKey(
      "jwk",
      payload.signingPrivateJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    ),
  ]);
  const proof = crypto.getRandomValues(new Uint8Array(32));
  const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsaPublic, proof);
  const opened = new Uint8Array(
    await crypto.subtle.decrypt({ name: "RSA-OAEP" }, rsaPrivate, wrapped),
  );
  if (opened.some((byte, index) => byte !== proof[index])) {
    throw new Error("Recovered encryption keypair does not match.");
  }
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    signingPrivate,
    proof,
  );
  if (
    !(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      signingPublic,
      signature,
      proof,
    ))
  ) {
    throw new Error("Recovered signing keypair does not match.");
  }
};

/** Decrypts and validates all current V1 key material before local installation. */
export const decryptAccountRecoveryPackage = async (
  encryptedValue: unknown,
  recoveryCode: string,
): Promise<AccountRecoveryPayloadV1> => {
  const encryptedPackage = parseEncryptedAccountRecoveryPackage(encryptedValue);
  if (!encryptedPackage) throw new TypeError("Recovery package is invalid.");
  const { metadata, ciphertext } = encryptedPackage;
  if ((await hash(ciphertext)) !== metadata.ciphertextDigest) {
    throw new Error("Recovery package was modified.");
  }
  const ciphertextBytes = fromBase64Url(ciphertext);
  if (ciphertextBytes.byteLength !== metadata.ciphertextLength) {
    throw new Error("Recovery package length is invalid.");
  }
  const key = await deriveRecoveryKey(
    recoveryCode,
    fromBase64Url(metadata.salt),
    metadata.userId,
    metadata.accountId,
  );
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64Url(metadata.iv),
        additionalData: encodeText(serializeAccountRecoveryPackageAad(metadata)),
      },
      key,
      ciphertextBytes,
    );
  } catch {
    throw new Error("Recovery code or package is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeText(plaintext));
  } catch {
    throw new Error("Recovered account data is invalid.");
  }
  const payload = parseAccountRecoveryPayload(parsed);
  if (
    !payload ||
    payload.accountId !== metadata.accountId ||
    payload.encryptionKid !== metadata.encryptionKid ||
    payload.signingKid !== metadata.signingKid ||
    (await fingerprintRecoverySigningKey(payload.signingPublicJwk)) !==
      metadata.signingKeyFingerprint
  ) {
    throw new Error("Recovered account data does not match its package.");
  }
  await verifyRecoveredKeyPairs(payload);
  return payload;
};

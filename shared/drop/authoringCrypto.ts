import {
  DROP_ENVELOPE_SCHEMA_V1,
  DROP_ENVELOPE_VERSION_V1,
  serializeCanonicalJson,
  serializeDropEnvelopeForDeviceSignature,
  type DropEnvelopeSignable,
  type DropEnvelopeV1,
  type DropMetadata,
  type DropPayload,
  type DropUnlockPolicy,
  type DropVisibility,
} from "./types";
import {
  isDropDeviceDelegation,
  type DropDeviceDelegation,
} from "./deviceDelegation";

/** Public account vault material used to wrap a newly generated content key. */
export interface DropAccountEncryptionMaterial {
  accountId: string;
  encryptionKid: string;
  encryptionPublicJwk: JsonWebKey;
  encryptionPublicKey: CryptoKey;
}

/** Local signing material for the device that authors the envelope. */
export interface DropDelegateSigningMaterial {
  signingKid: string;
  signingPublicJwk: JsonWebKey;
  signingPrivateKey: CryptoKey;
  deviceDelegation?: DropDeviceDelegation;
}

/** Public provider key used only for provider-escrow unlock policy. */
export interface DropProviderEncryptionMaterial {
  kid: string;
  publicKey: CryptoKey;
}

/** Inputs required to seal and device-sign an account-owned drop. */
export interface SealDropForAuthoringInput {
  payload: DropPayload;
  accountEncryption: DropAccountEncryptionMaterial;
  delegateSigning: DropDelegateSigningMaterial;
  providerEncryption?: DropProviderEncryptionMaterial;
  visibility: DropVisibility;
  unlockPolicy: DropUnlockPolicy;
  metadata?: DropMetadata;
  createdAt?: number;
}

const textEncoder = new TextEncoder();
const toBinaryString = (bytes: Uint8Array): string => {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return binary;
};
const toBase64 = (value: ArrayBuffer | Uint8Array): string => {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return btoa(toBinaryString(bytes));
};

const assertDelegationMatchesAuthoringMaterial = (
  accountEncryption: DropAccountEncryptionMaterial,
  delegateSigning: DropDelegateSigningMaterial,
) => {
  const delegation = delegateSigning.deviceDelegation;
  if (!delegation) return;
  if (!isDropDeviceDelegation(delegation)) {
    throw new Error("Device delegation is invalid.");
  }
  if (
    delegation.accountId !== accountEncryption.accountId ||
    delegation.encryptionKid !== accountEncryption.encryptionKid ||
    serializeCanonicalJson(delegation.encryptionPublicJwk) !==
      serializeCanonicalJson(accountEncryption.encryptionPublicJwk) ||
    serializeCanonicalJson(delegation.delegateSigningPublicJwk) !==
      serializeCanonicalJson(delegateSigning.signingPublicJwk)
  ) {
    throw new Error("Device delegation does not match the authoring material.");
  }
};

/** Seals and signs a drop using only caller-supplied Web Crypto key material. */
export const sealDropForAuthoring = async (
  input: SealDropForAuthoringInput,
): Promise<DropEnvelopeV1> => {
  const { payload, accountEncryption, delegateSigning } = input;
  assertDelegationMatchesAuthoringMaterial(accountEncryption, delegateSigning);
  if (input.unlockPolicy === "provider-escrow" && !input.providerEncryption) {
    throw new Error("Provider unlock policy requires provider encryption material.");
  }
  const contentKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    contentKey,
    textEncoder.encode(payload.content),
  );
  let draftCipher: DropEnvelopeSignable["draftCipher"];
  if (payload.draftPack) {
    const draftIv = crypto.getRandomValues(new Uint8Array(12));
    const draftCiphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: draftIv },
      contentKey,
      textEncoder.encode(JSON.stringify(payload.draftPack)),
    );
    draftCipher = {
      alg: "A256GCM",
      iv: toBase64(draftIv),
      ciphertext: toBase64(draftCiphertext),
    };
  }
  const rawContentKey = await crypto.subtle.exportKey("raw", contentKey);
  const wrappedKey = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    accountEncryption.encryptionPublicKey,
    rawContentKey,
  );
  let providerEscrow: DropEnvelopeSignable["providerEscrow"];
  if (input.unlockPolicy === "provider-escrow") {
    const providerEncryption = input.providerEncryption;
    if (!providerEncryption) {
      throw new Error("Provider unlock policy requires provider encryption material.");
    }
    const escrowWrappedKey = await crypto.subtle.encrypt(
      { name: "RSA-OAEP" },
      providerEncryption.publicKey,
      rawContentKey,
    );
    providerEscrow = {
      mode: "provider-rsa-oaep",
      kid: providerEncryption.kid,
      wrappedKey: toBase64(escrowWrappedKey),
    };
  }
  const signable: DropEnvelopeSignable = {
    schema: DROP_ENVELOPE_SCHEMA_V1,
    version: DROP_ENVELOPE_VERSION_V1,
    createdAt: input.createdAt ?? Date.now(),
    accountId: accountEncryption.accountId,
    visibility: input.visibility,
    unlockPolicy: input.unlockPolicy,
    metadata: input.metadata,
    cipher: { alg: "A256GCM", iv: toBase64(iv), ciphertext: toBase64(ciphertext) },
    draftCipher,
    keyEnvelope: {
      mode: "account-vault-rsa-oaep",
      kid: accountEncryption.encryptionKid,
      wrappedKey: toBase64(wrappedKey),
    },
    deviceSignerPublicJwk: delegateSigning.signingPublicJwk,
    deviceDelegation: delegateSigning.deviceDelegation,
    providerEscrow,
  };
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    delegateSigning.signingPrivateKey,
    textEncoder.encode(serializeDropEnvelopeForDeviceSignature(signable)),
  );
  return {
    ...signable,
    signatures: {
      device: {
        kid: delegateSigning.signingKid,
        alg: "ECDSA_P256_SHA256",
        sig: toBase64(signature),
      },
    },
  };
};

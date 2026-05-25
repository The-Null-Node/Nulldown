import {
  DROP_ENVELOPE_SCHEMA_V1,
  DROP_ENVELOPE_VERSION_V1,
  serializeDropEnvelopeForDeviceSignature,
  type DropEnvelopeV1,
  type DropMetadata,
} from "../../../shared/drop/types";
import { toBase64 } from "./providerEscrow";

const textEncoder = new TextEncoder();

interface JwkWithKid extends JsonWebKey {
  kid?: string;
}

const deriveRsaPublicJwk = (privateJwk: JwkWithKid): JwkWithKid => {
  if (
    privateJwk.kty !== "RSA" ||
    typeof privateJwk.n !== "string" ||
    typeof privateJwk.e !== "string"
  ) {
    throw new Error("Provider encryption key is not a valid RSA JWK.");
  }

  return {
    kty: "RSA",
    n: privateJwk.n,
    e: privateJwk.e,
    alg: "RSA-OAEP-256",
    ext: true,
    key_ops: ["encrypt"],
    kid: typeof privateJwk.kid === "string" ? privateJwk.kid : "provider",
  };
};

const deriveEcPublicJwk = (privateJwk: JwkWithKid): JwkWithKid => {
  if (
    privateJwk.kty !== "EC" ||
    privateJwk.crv !== "P-256" ||
    typeof privateJwk.x !== "string" ||
    typeof privateJwk.y !== "string"
  ) {
    throw new Error("Provider signing key is not a valid P-256 EC JWK.");
  }

  return {
    kty: "EC",
    crv: "P-256",
    x: privateJwk.x,
    y: privateJwk.y,
    alg: "ES256",
    ext: true,
    key_ops: ["verify"],
    kid: typeof privateJwk.kid === "string" ? privateJwk.kid : "provider",
  };
};

export interface CreatePromotedEnvelopeInput {
  content: string;
  accountId: string;
  metadata: DropMetadata;
  providerEncryptionPrivateJwk: string;
  providerSigningPrivateJwk: string;
}

export const createPromotedEnvelope = async (
  input: CreatePromotedEnvelopeInput,
): Promise<DropEnvelopeV1> => {
  const encryptionPrivateJwk = JSON.parse(
    input.providerEncryptionPrivateJwk,
  ) as JwkWithKid;
  const signingPrivateJwk = JSON.parse(
    input.providerSigningPrivateJwk,
  ) as JwkWithKid;

  const encryptionPublicJwk = deriveRsaPublicJwk(encryptionPrivateJwk);
  const signingPublicJwk = deriveEcPublicJwk(signingPrivateJwk);

  const encryptionPublicKey = await crypto.subtle.importKey(
    "jwk",
    encryptionPublicJwk,
    {
      name: "RSA-OAEP",
      hash: "SHA-256",
    },
    false,
    ["encrypt"],
  );

  const signingPrivateKey = await crypto.subtle.importKey(
    "jwk",
    signingPrivateJwk,
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    false,
    ["sign"],
  );

  const contentKey = (await crypto.subtle.generateKey(
    {
      name: "AES-GCM",
      length: 256,
    },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKey;

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
    },
    contentKey,
    textEncoder.encode(input.content),
  );

  const rawContentKey = (await crypto.subtle.exportKey(
    "raw",
    contentKey,
  )) as ArrayBuffer;
  const wrappedKey = await crypto.subtle.encrypt(
    {
      name: "RSA-OAEP",
    },
    encryptionPublicKey,
    rawContentKey,
  );

  const escrowWrappedKey = await crypto.subtle.encrypt(
    {
      name: "RSA-OAEP",
    },
    encryptionPublicKey,
    rawContentKey,
  );

  const now = Date.now();
  const keyId =
    typeof encryptionPublicJwk.kid === "string"
      ? encryptionPublicJwk.kid
      : "provider";
  const signingKeyId =
    typeof signingPublicJwk.kid === "string"
      ? signingPublicJwk.kid
      : "provider";

  const signableEnvelope = {
    schema: DROP_ENVELOPE_SCHEMA_V1,
    version: DROP_ENVELOPE_VERSION_V1,
    createdAt: now,
    accountId: input.accountId,
    visibility: "unlisted" as const,
    unlockPolicy: "provider-escrow" as const,
    metadata: input.metadata,
    cipher: {
      alg: "A256GCM" as const,
      iv: toBase64(
        iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength),
      ),
      ciphertext: toBase64(ciphertext),
    },
    keyEnvelope: {
      mode: "account-vault-rsa-oaep" as const,
      kid: keyId,
      wrappedKey: toBase64(wrappedKey),
    },
    providerEscrow: {
      mode: "provider-rsa-oaep" as const,
      kid: keyId,
      wrappedKey: toBase64(escrowWrappedKey),
    },
    deviceSignerPublicJwk: signingPublicJwk,
  };

  const signaturePayload =
    serializeDropEnvelopeForDeviceSignature(signableEnvelope);
  const signature = await crypto.subtle.sign(
    {
      name: "ECDSA",
      hash: "SHA-256",
    },
    signingPrivateKey,
    textEncoder.encode(signaturePayload),
  );

  return {
    ...signableEnvelope,
    signatures: {
      device: {
        kid: signingKeyId,
        alg: "ECDSA_P256_SHA256",
        sig: toBase64(signature),
      },
    },
  };
};

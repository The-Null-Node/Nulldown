import {
  isDropDraftPackV1,
  type DropCipherRecord,
  type DropDraftPackV1,
} from "../../../../shared/drop/types";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type EcP256PrivateJwk = JsonWebKey & {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  kid?: string;
};

type RsaPrivateJwk = JsonWebKey & {
  kty: "RSA";
  n: string;
  e: string;
  kid?: string;
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const isEcP256PrivateJwk = (jwk: JsonWebKey): jwk is EcP256PrivateJwk =>
  jwk.kty === "EC" &&
  jwk.crv === "P-256" &&
  typeof jwk.x === "string" &&
  typeof jwk.y === "string";

const isRsaPrivateJwk = (jwk: JsonWebKey): jwk is RsaPrivateJwk =>
  jwk.kty === "RSA" && typeof jwk.n === "string" && typeof jwk.e === "string";

/** Result of encrypting text with a freshly generated AES-GCM content key. */
export interface ServerVoidEncryptedText {
  rawContentKey: ArrayBuffer;
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
}

/** Server-side Web Crypto boundary for provider signing and escrow flows. */
export class ServerVoidCrypto {
  /** Encodes binary Web Crypto output for persisted drop envelopes and API responses. */
  toBase64(value: ArrayBuffer | Uint8Array): string {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    let binary = "";

    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });

    return btoa(binary);
  }

  /** Decodes persisted envelope fields into binary inputs for Web Crypto. */
  fromBase64(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  }

  /** Returns the public RSA JWK and key id embedded in a provider private key. */
  deriveProviderEncryptionPublicJwk(privateJwk: JsonWebKey): {
    jwk: JsonWebKey;
    kid: string;
  } {
    if (!isRsaPrivateJwk(privateJwk)) {
      throw new Error("Provider encryption key is not a valid RSA JWK.");
    }

    const kid =
      typeof privateJwk.kid === "string" ? privateJwk.kid : "provider";

    return {
      kid,
      jwk: {
        kty: "RSA",
        n: privateJwk.n,
        e: privateJwk.e,
        alg: "RSA-OAEP-256",
        ext: true,
        key_ops: ["encrypt"],
        kid,
      },
    };
  }

  /** Returns the public P-256 JWK and key id embedded in a provider signing key. */
  deriveProviderSigningPublicJwk(privateJwk: JsonWebKey): {
    jwk: JsonWebKey;
    kid: string;
  } {
    if (!isEcP256PrivateJwk(privateJwk)) {
      throw new Error("Provider signing key is not a valid P-256 EC JWK.");
    }

    const kid =
      typeof privateJwk.kid === "string" ? privateJwk.kid : "provider";

    return {
      kid,
      jwk: {
        kty: "EC",
        crv: "P-256",
        x: privateJwk.x,
        y: privateJwk.y,
        alg: "ES256",
        ext: true,
        key_ops: ["verify"],
        kid,
      },
    };
  }

  /** Signs canonical payload text with a provider P-256 private JWK. */
  async signWithProviderKey(
    payload: string,
    privateJwk: JsonWebKey,
  ): Promise<ArrayBuffer> {
    const key = await crypto.subtle.importKey(
      "jwk",
      privateJwk,
      {
        name: "ECDSA",
        namedCurve: "P-256",
      },
      false,
      ["sign"],
    );

    return crypto.subtle.sign(
      {
        name: "ECDSA",
        hash: "SHA-256",
      },
      key,
      textEncoder.encode(payload),
    );
  }

  /** Encrypts plaintext with a new AES-GCM content key. */
  async encryptTextWithNewContentKey(
    content: string,
  ): Promise<ServerVoidEncryptedText> {
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
      textEncoder.encode(content),
    );
    const rawContentKey = (await crypto.subtle.exportKey(
      "raw",
      contentKey,
    )) as ArrayBuffer;

    return {
      rawContentKey,
      iv,
      ciphertext,
    };
  }

  /** Wraps a raw AES content key for a provider RSA-OAEP public JWK. */
  async wrapRawContentKeyWithProviderPublicJwk(
    publicJwk: JsonWebKey,
    rawContentKey: BufferSource,
  ): Promise<ArrayBuffer> {
    const key = await crypto.subtle.importKey(
      "jwk",
      publicJwk,
      {
        name: "RSA-OAEP",
        hash: "SHA-256",
      },
      false,
      ["encrypt"],
    );

    return crypto.subtle.encrypt(
      {
        name: "RSA-OAEP",
      },
      key,
      rawContentKey,
    );
  }

  /** Unwraps a provider-escrowed AES content key with a provider RSA private JWK string. */
  async unwrapProviderContentKey(
    rawProviderPrivateJwk: string,
    wrappedKey: string,
  ): Promise<ArrayBuffer> {
    const privateKey = await this.importProviderPrivateKey(
      rawProviderPrivateJwk,
    );
    return this.decryptProviderWrappedContentKey(privateKey, wrappedKey);
  }

  /** Decrypts provider-wrapped content key bytes with an already imported RSA private key. */
  async decryptProviderWrappedContentKey(
    providerPrivateKey: CryptoKey,
    wrappedKey: string,
  ): Promise<ArrayBuffer> {
    return crypto.subtle.decrypt(
      {
        name: "RSA-OAEP",
      },
      providerPrivateKey,
      this.fromBase64(wrappedKey),
    );
  }

  /** Re-wraps raw content key bytes to a requester RSA-OAEP public JWK. */
  async wrapRawContentKeyForRequester(
    requesterPublicJwk: JsonWebKey,
    rawContentKey: BufferSource,
  ): Promise<string> {
    const requesterPublicKey = await this.importRequesterPublicKey(
      requesterPublicJwk,
    );
    return this.wrapRawContentKeyWithRequesterPublicKey(
      requesterPublicKey,
      rawContentKey,
    );
  }

  /** Re-wraps raw content key bytes with an already imported requester public key. */
  async wrapRawContentKeyWithRequesterPublicKey(
    requesterPublicKey: CryptoKey,
    rawContentKey: BufferSource,
  ): Promise<string> {
    const wrappedKey = await crypto.subtle.encrypt(
      {
        name: "RSA-OAEP",
      },
      requesterPublicKey,
      rawContentKey,
    );

    return this.toBase64(wrappedKey);
  }

  /** Wraps UTF-8 text to a requester RSA-OAEP public JWK and returns base64. */
  async wrapTextForRequester(
    requesterPublicJwk: JsonWebKey,
    content: string,
  ): Promise<string> {
    return this.wrapRawContentKeyForRequester(
      requesterPublicJwk,
      textEncoder.encode(content),
    );
  }

  /** Decrypts an AES-GCM envelope cipher with raw content key bytes. */
  async decryptCipherText(
    rawContentKey: BufferSource,
    cipher: DropCipherRecord,
  ): Promise<string> {
    const contentKey = await this.importAesKey(rawContentKey, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: this.fromBase64(cipher.iv),
      },
      contentKey,
      this.fromBase64(cipher.ciphertext),
    );

    return textDecoder.decode(plaintext);
  }

  /** Decrypts an optional draft pack; failures return undefined so content can still open. */
  async decryptDraftPack(
    rawContentKey: BufferSource,
    cipher: DropCipherRecord | undefined,
  ): Promise<DropDraftPackV1 | undefined> {
    if (!cipher) {
      return undefined;
    }

    try {
      const plaintext = await this.decryptCipherText(rawContentKey, cipher);
      const parsed = JSON.parse(plaintext) as unknown;
      return isDropDraftPackV1(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /** Converts an AES-GCM IV to a base64 string without exposing backing-buffer padding. */
  encodeIv(iv: Uint8Array): string {
    return this.toBase64(toArrayBuffer(iv));
  }

  /** Imports a provider RSA-OAEP private key for escrow unwrap operations. */
  async importProviderPrivateKey(raw: string): Promise<CryptoKey> {
    const jwk = JSON.parse(raw) as JsonWebKey;
    return crypto.subtle.importKey(
      "jwk",
      jwk,
      {
        name: "RSA-OAEP",
        hash: "SHA-256",
      },
      false,
      ["decrypt"],
    );
  }

  /** Imports a requester RSA-OAEP public key for key re-wrap operations. */
  async importRequesterPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
    return crypto.subtle.importKey(
      "jwk",
      jwk,
      {
        name: "RSA-OAEP",
        hash: "SHA-256",
      },
      false,
      ["encrypt"],
    );
  }

  private importAesKey(
    rawContentKey: BufferSource,
    usages: Array<"encrypt" | "decrypt">,
  ): Promise<CryptoKey> {
    return crypto.subtle.importKey(
      "raw",
      rawContentKey,
      { name: "AES-GCM" },
      false,
      usages,
    );
  }
}

/** Shared server-side crypto instance for stateless Pages Function helpers. */
export const serverVoidCrypto = new ServerVoidCrypto();

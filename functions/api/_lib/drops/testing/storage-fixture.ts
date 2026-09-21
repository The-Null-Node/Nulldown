import {
  encodeDropEnvelope,
  serializeDropEnvelopeForDeviceSignature,
  toDropEnvelopeSignable,
} from "../../../../../shared/drop/codecs/envelope-v1";
import type { DropEnvelope } from "../../../../../shared/drop/types";

interface StoredObject {
  value: string;
  contentType: string;
  etag: string;
  uploaded: Date;
}

export class MemoryR2Bucket {
  private readonly objects = new Map<string, StoredObject>();
  private etagSequence = 0;

  seed(key: string, value: string, contentType = "application/json"): string {
    const etag = this.createEtag(`${key}:${value}:${Date.now()}`);
    this.objects.set(key, {
      value,
      contentType,
      etag,
      uploaded: new Date(),
    });

    return etag;
  }

  async get(key: string): Promise<any> {
    const existing = this.objects.get(key);
    if (!existing) {
      return null;
    }

    return {
      body: new Response(existing.value).body,
      httpMetadata: { contentType: existing.contentType },
      httpEtag: existing.etag,
      uploaded: existing.uploaded,
      etag: existing.etag,
      key,
      size: existing.value.length,
      checksums: {
        md5: undefined,
        sha1: undefined,
        sha256: undefined,
        sha384: undefined,
        sha512: undefined,
      },
      version: "v1",
      writeHttpMetadata: () => {},
      writeChecksums: () => {},
      arrayBuffer: async () =>
        new TextEncoder().encode(existing.value).buffer as ArrayBuffer,
      text: async () => existing.value,
      json: async <T>() => JSON.parse(existing.value) as T,
      blob: async () => new Blob([existing.value]),
    };
  }

  async head(key: string): Promise<any> {
    const existing = this.objects.get(key);
    if (!existing) return null;
    return {
      httpEtag: existing.etag,
      etag: existing.etag,
      key,
      size: existing.value.length,
      uploaded: existing.uploaded,
    };
  }

  async put(
    key: string,
    value:
      string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream | null,
    options?: any,
  ): Promise<any> {
    const existing = this.objects.get(key);
    const onlyIf = options?.onlyIf;

    if (onlyIf && "etagDoesNotMatch" in onlyIf) {
      if (onlyIf.etagDoesNotMatch === "*" && existing) {
        return null;
      }
    }

    if (onlyIf && "etagMatches" in onlyIf) {
      if (!existing || existing.etag !== onlyIf.etagMatches) {
        return null;
      }
    }

    const asText = await this.toText(value);
    const uploaded = new Date();
    const metadata = options?.httpMetadata;
    const contentType =
      metadata &&
      typeof metadata === "object" &&
      "contentType" in metadata &&
      typeof (metadata as { contentType?: unknown }).contentType === "string"
        ? (metadata as { contentType: string }).contentType
        : "text/plain";

    const next: StoredObject = {
      value: asText,
      contentType,
      etag: this.createEtag(`${key}:${asText}:${uploaded.getTime()}`),
      uploaded,
    };
    this.objects.set(key, next);

    return {
      key,
      etag: next.etag,
      size: asText.length,
      uploaded,
      checksums: {
        md5: undefined,
        sha1: undefined,
        sha256: undefined,
        sha384: undefined,
        sha512: undefined,
      },
      httpEtag: next.etag,
      version: "v1",
      httpMetadata: { contentType: next.contentType },
      customMetadata: {},
      range: undefined,
      writeHttpMetadata: () => {},
      writeChecksums: () => {},
    };
  }

  async delete(keys: string | string[]): Promise<void> {
    if (Array.isArray(keys)) {
      keys.forEach((key) => this.objects.delete(key));
      return;
    }

    this.objects.delete(keys);
  }

  private createEtag(input: string): string {
    this.etagSequence += 1;
    return `memory-etag-${this.etagSequence}-${input.length}`;
  }

  private async toText(
    value:
      string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream | null,
  ): Promise<string> {
    if (typeof value === "string") {
      return value;
    }

    if (value === null) {
      return "";
    }

    return await new Response(value as BodyInit).text();
  }
}

export class RacingMemoryR2Bucket extends MemoryR2Bucket {
  private didRace = false;

  override async put(
    key: string,
    value: Parameters<MemoryR2Bucket["put"]>[1],
    options?: unknown,
  ): Promise<any> {
    if (!this.didRace && key === "RaceLock00005") {
      this.didRace = true;
      this.seed(key, "concurrent replacement", "text/plain");
    }
    return super.put(key, value, options);
  }
}

export const createEnvelope = (accountId = "account-1"): DropEnvelope => ({
  createdAt: Date.now(),
  accountId,
  visibility: "unlisted",
  unlockPolicy: "provider-escrow",
  metadata: {},
  cipher: {
    alg: "A256GCM",
    iv: "iv",
    ciphertext: "cipher",
  },
  keyEnvelope: {
    mode: "account-vault-rsa-oaep",
    kid: "enc-kid",
    wrappedKey: "wrapped",
  },
  signatures: {
    device: {
      kid: "sig-kid",
      alg: "ECDSA_P256_SHA256",
      sig: "sig",
    },
  },
});

export const serializeEnvelope = (envelope: DropEnvelope): string =>
  JSON.stringify(encodeDropEnvelope(envelope));

const toBase64Url = (value: ArrayBuffer): string => {
  let binary = "";
  new Uint8Array(value).forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

export const createSignedOwnerEnvelope = async (accountId: string) => {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const signingPublicJwk = (await crypto.subtle.exportKey(
    "jwk",
    pair.publicKey,
  )) as JsonWebKey;
  const envelope = createEnvelope(accountId);
  envelope.deviceSignerPublicJwk = signingPublicJwk;
  envelope.signatures.device.sig = toBase64Url(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      pair.privateKey,
      new TextEncoder().encode(
        serializeDropEnvelopeForDeviceSignature(
          toDropEnvelopeSignable(envelope),
        ),
      ),
    ),
  );
  return { envelope, signingPublicJwk };
};

export const createProviderSigningPrivateJwk =
  async (): Promise<JsonWebKey> => {
    const pair = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    return {
      ...((await crypto.subtle.exportKey(
        "jwk",
        pair.privateKey,
      )) as JsonWebKey),
      kid: "provider-test",
    } as unknown as JsonWebKey;
  };

export const createStoreDatabase = (input?: {
  entry?: {
    entry_seq: number;
    drop_id: string;
    account_id: string;
    visibility: "private" | "unlisted" | "public";
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
  } | null;
  accounts?: Map<string, { account_id: string; signing_public_jwk: string }>;
}) => ({
  prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind: (...bound: unknown[]) => {
        values = bound;
        return statement;
      },
      first: async () => {
        if (sql.includes("FROM account_library_entries")) {
          return input?.entry ?? null;
        }
        if (sql.includes("FROM accounts")) {
          return input?.accounts?.get(String(values[0])) ?? null;
        }
        return null;
      },
      all: async () => ({ results: [] }),
      run: async () => ({ success: true }),
    };
    return statement;
  },
});

export const createStoreRequest = (
  body: unknown,
  accountId?: string,
): Request => {
  const envelope =
    typeof body === "object" && body !== null && "envelope" in body
      ? (body as { envelope?: unknown }).envelope
      : null;
  const wireBody =
    envelope &&
    typeof envelope === "object" &&
    "createdAt" in envelope &&
    "signatures" in envelope
      ? {
          ...(body as Record<string, unknown>),
          envelope: encodeDropEnvelope(envelope as DropEnvelope),
        }
      : body;

  return new Request("https://nulldown.test/api/store", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accountId ? { "x-nulldown-account-id": accountId } : {}),
    },
    body: JSON.stringify(wireBody),
  });
};

export const createDeleteRequest = (
  id: string,
  revision?: string,
  accountId?: string,
): Request =>
  new Request(`https://nulldown.test/api/delete/${id}`, {
    method: "DELETE",
    headers: {
      ...(revision ? { "If-Match": revision } : {}),
      ...(accountId ? { "x-nulldown-account-id": accountId } : {}),
    },
  });

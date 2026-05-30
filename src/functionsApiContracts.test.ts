import { createHash } from "node:crypto";
import { jest } from "@jest/globals";
import type { R2Bucket } from "@cloudflare/workers-types";
import { createRemoteAliasKey } from "../functions/api/_lib/drops/identity/id";
import { onRequestDelete } from "../functions/api/delete/[id]";
import { onRequestPost as onStorePost } from "../functions/api/store";
import type { DropEnvelopeV1 } from "../shared/drop/types";

interface StoredObject {
  value: string;
  contentType: string;
  etag: string;
  uploaded: Date;
}

class MemoryR2Bucket {
  private readonly objects = new Map<string, StoredObject>();

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

  async put(
    key: string,
    value:
      | string
      | ArrayBuffer
      | ArrayBufferView
      | Blob
      | ReadableStream
      | null,
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
    return createHash("sha1").update(input).digest("hex");
  }

  private async toText(
    value:
      | string
      | ArrayBuffer
      | ArrayBufferView
      | Blob
      | ReadableStream
      | null,
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

const createEnvelope = (accountId = "account-1"): DropEnvelopeV1 => ({
  schema: "nmdn.drop.v1",
  version: 1,
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

const createStoreRequest = (body: unknown): Request =>
  new Request("https://nulldown.test/api/store", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

const createDeleteRequest = (id: string, revision: string): Request =>
  new Request(`https://nulldown.test/api/delete/${id}`, {
    method: "DELETE",
    headers: {
      "If-Match": revision,
    },
  });

describe("functions api conflict contracts", () => {
  let infoSpy: jest.SpiedFunction<typeof console.info>;
  let warnSpy: jest.SpiedFunction<typeof console.warn>;
  let errorSpy: jest.SpiedFunction<typeof console.error>;
  let debugSpy: jest.SpiedFunction<typeof console.debug>;

  beforeEach(() => {
    infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    debugSpy = jest.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it("returns 409 alias_conflict from /api/store as structured JSON", async () => {
    const bucket = new MemoryR2Bucket();
    const existingId = "AaBbCc112233";
    const requestedId = "AaBbCc445566";

    bucket.seed(createRemoteAliasKey("AaBbCc"), existingId, "text/plain");

    const response = await onStorePost({
      request: createStoreRequest({
        id: requestedId,
        upsert: false,
        envelope: createEnvelope(),
      }),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        PUBLIC_BASE_URL: "https://nulldown.test",
      },
    } as unknown as Parameters<typeof onStorePost>[0]);

    const body = (await response.json()) as {
      error: string;
      code: string;
      details?: Record<string, unknown>;
    };

    expect(response.status).toBe(409);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(body.code).toBe("alias_conflict");
    expect(body.error).toContain("already in use");
  });

  it("returns 412 revision_precondition_failed from /api/store as structured JSON", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "QweRty123456";

    bucket.seed(id, JSON.stringify(createEnvelope()), "application/json");
    bucket.seed(createRemoteAliasKey("QweRty"), id, "text/plain");

    const response = await onStorePost({
      request: createStoreRequest({
        id,
        upsert: true,
        expectedRevision: "mismatched-etag",
        envelope: createEnvelope(),
      }),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        PUBLIC_BASE_URL: "https://nulldown.test",
      },
    } as unknown as Parameters<typeof onStorePost>[0]);

    const body = (await response.json()) as {
      error: string;
      code: string;
      details?: Record<string, unknown>;
    };

    expect(response.status).toBe(412);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(body.code).toBe("revision_precondition_failed");
    expect(body.error).toContain("Refresh and try again");
  });

  it("accepts quoted revision tokens from /api/get headers for /api/store upserts", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "QuoteRev1234";

    const etag = bucket.seed(id, JSON.stringify(createEnvelope()), "application/json");
    bucket.seed(createRemoteAliasKey("QuoteR"), id, "text/plain");

    const response = await onStorePost({
      request: createStoreRequest({
        id,
        upsert: true,
        expectedRevision: `"${etag}"`,
        envelope: createEnvelope("account-2"),
      }),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        PUBLIC_BASE_URL: "https://nulldown.test",
      },
    } as unknown as Parameters<typeof onStorePost>[0]);

    const body = (await response.json()) as { id: string; url: string };

    expect(response.status).toBe(200);
    expect(body.id).toBe(id);
  });

  it("returns 412 revision_precondition_failed from /api/delete/:id as structured JSON", async () => {
    const bucket = new MemoryR2Bucket();
    const id = "ZxCvBn123456";
    bucket.seed(id, "drop body", "text/plain");

    const response = await onRequestDelete({
      request: createDeleteRequest(id, "wrong-revision"),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
      },
      params: {
        id,
      },
    } as unknown as Parameters<typeof onRequestDelete>[0]);

    const body = (await response.json()) as {
      error: string;
      code: string;
      details?: Record<string, unknown>;
    };

    expect(response.status).toBe(412);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(body.code).toBe("revision_precondition_failed");
    expect(body.error).toContain("Refresh and try again");
    expect(await bucket.get(id)).not.toBeNull();
  });
});

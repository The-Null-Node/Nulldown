import { createHash } from "node:crypto";

interface StoredObject {
  value: string;
  contentType: string;
  etag: string;
  uploaded: Date;
}

export class MemoryR2Bucket {
  private readonly objects = new Map<string, StoredObject>();

  seed(key: string, value: string, contentType = "application/json"): void {
    const uploaded = new Date();
    this.objects.set(key, {
      value,
      contentType,
      etag: createHash("sha1").update(`${key}:${value}`).digest("hex"),
      uploaded,
    });
  }

  async get(key: string): Promise<any> {
    const existing = this.objects.get(key);
    if (!existing) return null;
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

  async put(key: string, value: string, options?: any): Promise<any> {
    const existing = this.objects.get(key);
    if (options?.onlyIf?.etagDoesNotMatch === "*" && existing) {
      return null;
    }

    const uploaded = new Date();
    const next: StoredObject = {
      value,
      contentType: options?.httpMetadata?.contentType ?? "text/plain",
      etag: createHash("sha1").update(`${key}:${value}`).digest("hex"),
      uploaded,
    };
    this.objects.set(key, next);
    return { key, etag: next.etag, uploaded };
  }

  async delete(keys: string | string[]): Promise<void> {
    (Array.isArray(keys) ? keys : [keys]).forEach((key) =>
      this.objects.delete(key),
    );
  }

  async list(
    options: { prefix?: string; cursor?: string; limit?: number } = {},
  ): Promise<any> {
    const prefix = options.prefix ?? "";
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort();
    return {
      objects: keys.map((key) => {
        const object = this.objects.get(key)!;
        return {
          key,
          etag: object.etag,
          httpEtag: object.etag,
          uploaded: object.uploaded,
          size: object.value.length,
        };
      }),
      truncated: false,
    };
  }
}

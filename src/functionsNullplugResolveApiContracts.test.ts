import { createHash } from "node:crypto";
import { jest } from "@jest/globals";
import type { R2Bucket } from "@cloudflare/workers-types";
import { onRequest } from "../functions/api/nullplug/resolve";

interface StoredObject {
  value: string;
  contentType: string;
  etag: string;
  uploaded: Date;
}

class MemoryR2Bucket {
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
}

const rootDropId = "RootDrop1122";
const childDropId = "ChildDrop3344";

const createResolveRequest = (body: unknown): Request =>
  new Request("https://nulldown.test/api/nullplug/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const createInvokeBody = (pluginId = "nd", id = childDropId) => ({
  call: {
    pluginId,
    args: { id },
    caller: { dropId: rootDropId, branchId: "clone_anonymous" },
  },
  context: {
    providerId: "nulldown-provider",
    baseUrl: "https://nulldown.test",
    capabilities: ["render", "drop.read"],
  },
});

describe("functions api nullplug resolve contracts", () => {
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

  const createSeededBucket = (): MemoryR2Bucket => {
    const bucket = new MemoryR2Bucket();
    bucket.seed(
      childDropId,
      JSON.stringify({
        content: "# Child Plan\n\nThis child plan is resolved by the provider.",
        metadata: { rootDropId },
      }),
    );
    return bucket;
  };

  it("resolves built-in nd calls through the provider boundary", async () => {
    const bucket = createSeededBucket();

    const response = await onRequest({
      request: createResolveRequest(createInvokeBody()),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);

    const body = (await response.json()) as {
      result: { content: string; metadata: Record<string, unknown> };
      diagnostics: Array<{ level: string; message: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.result.content).toContain("[Child Plan](/d/ChildD)");
    expect(body.result.content).toContain(
      "This child plan is resolved by the provider.",
    );
    expect(body.result.metadata.resolvedDropId).toBe(childDropId);
    expect(body.diagnostics[0].level).toBe("info");
  });

  it("rejects unsupported plugins instead of resolving remote code", async () => {
    const bucket = createSeededBucket();

    const response = await onRequest({
      request: createResolveRequest(createInvokeBody("remote-plugin")),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);

    const body = (await response.json()) as { code: string };
    expect(response.status).toBe(400);
    expect(body.code).toBe("unsupported_plugin");
  });

  it("rejects invalid invoke requests", async () => {
    const bucket = createSeededBucket();

    const response = await onRequest({
      request: createResolveRequest({ call: { pluginId: "nd" } }),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);

    const body = (await response.json()) as { code: string };
    expect(response.status).toBe(400);
    expect(body.code).toBe("validation_failed");
  });
});

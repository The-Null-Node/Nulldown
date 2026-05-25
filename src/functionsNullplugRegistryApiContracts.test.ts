import { createHash, createHmac } from "node:crypto";
import { jest } from "@jest/globals";
import type { R2Bucket } from "@cloudflare/workers-types";
import { onRequest } from "../functions/api/nullplug/registry";
import {
  NULLPLUG_MANIFEST_SIGNATURE_PREFIX,
  serializeRemoteNullplugManifestForSignature,
  type RemoteNullplugManifest,
} from "../shared/nullplug/registry";

interface StoredObject {
  value: string;
  contentType: string;
  etag: string;
  uploaded: Date;
}

class MemoryR2Bucket {
  private readonly objects = new Map<string, StoredObject>();

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

  async list(options?: { prefix?: string; limit?: number }): Promise<any> {
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1000;
    const objects = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, limit)
      .map(([key, value]) => ({ key, size: value.value.length }));
    return { objects, truncated: false, cursor: undefined, delimitedPrefixes: [] };
  }
}

const signatureSecret = "registry-secret";

const signManifest = (manifest: RemoteNullplugManifest): RemoteNullplugManifest => ({
  ...manifest,
  signature: `${NULLPLUG_MANIFEST_SIGNATURE_PREFIX}${createHmac(
    "sha256",
    signatureSecret,
  )
    .update(serializeRemoteNullplugManifestForSignature(manifest))
    .digest("hex")}`,
});

const createManifest = (): RemoteNullplugManifest =>
  signManifest({
    id: "remote.summary",
    version: "1.0.0",
    endpoint: "https://plugins.nulldown.test/summary",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    permissions: [
      { kind: "drop.read", scope: "caller" },
      { kind: "network", hosts: ["api.nulldown.test"] },
    ],
    description: "Summarizes a linked drop.",
  });

const createRequest = (method: "GET" | "POST", body?: unknown, accountId?: string) =>
  new Request("https://nulldown.test/api/nullplug/registry", {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(accountId ? { "x-nulldown-account-id": accountId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const envFor = (bucket: MemoryR2Bucket) => ({
  R2_BUCKET: bucket as unknown as R2Bucket,
  NULLPLUG_REGISTRY_SIGNATURE_SECRET: signatureSecret,
  NULLPLUG_REGISTRY_ALLOWED_HOSTS:
    "plugins.nulldown.test,api.nulldown.test",
});

describe("functions api nullplug registry contracts", () => {
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

  it("registers signed manifests with account auth and lists active manifests", async () => {
    const bucket = new MemoryR2Bucket();
    const response = await onRequest({
      request: createRequest("POST", createManifest(), "acct-1"),
      env: envFor(bucket),
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);

    const body = (await response.json()) as { registered: boolean; record: unknown };
    expect(response.status).toBe(200);
    expect(body.registered).toBe(true);

    const listed = await onRequest({
      request: createRequest("GET"),
      env: envFor(bucket),
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);

    const listBody = (await listed.json()) as { items: RemoteNullplugManifest[] };
    expect(listed.status).toBe(200);
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0].id).toBe("remote.summary");
  });

  it("requires account auth for registration", async () => {
    const bucket = new MemoryR2Bucket();
    const response = await onRequest({
      request: createRequest("POST", createManifest()),
      env: envFor(bucket),
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);

    const body = (await response.json()) as { code: string };
    expect(response.status).toBe(401);
    expect(body.code).toBe("unauthorized");
  });

  it("rejects invalid signatures and disallowed manifests", async () => {
    const bucket = new MemoryR2Bucket();
    const invalidSignature = await onRequest({
      request: createRequest(
        "POST",
        { ...createManifest(), signature: "sha256:bad" },
        "acct-1",
      ),
      env: envFor(bucket),
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(invalidSignature.status).toBe(401);

    const disallowed = await onRequest({
      request: createRequest("POST", createManifest(), "acct-1"),
      env: {
        ...envFor(bucket),
        NULLPLUG_REGISTRY_ALLOWED_HOSTS: "plugins.nulldown.test",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    const body = (await disallowed.json()) as { code: string };
    expect(disallowed.status).toBe(400);
    expect(body.code).toBe("manifest_not_allowed");
  });
});

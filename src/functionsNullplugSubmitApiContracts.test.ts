import { createHash } from "node:crypto";
import { jest } from "@jest/globals";
import type { R2Bucket } from "@cloudflare/workers-types";
import { onRequest } from "../functions/api/nullplug/submit";
import { nullplugUiResponseFactKey } from "../shared/nullplug/ui";

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
}

const rootDropId = "RootDrop1122";

const createSubmitRequest = (body: unknown): Request =>
  new Request("https://nulldown.test/api/nullplug/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const createFact = () => ({
  version: 1 as const,
  kind: "ui.response" as const,
  id: "response-1",
  primitiveId: "approval-form",
  createdAt: 123,
  source: { rootDropId, branchId: "clone_anonymous", snapshotId: 4 },
  data: { approved: true, reason: "looks good" },
  proposedDiffs: {
    version: 1 as const,
    events: [
      {
        eventId: "event-1",
        seq: 0,
        dropId: rootDropId,
        sourceClientId: "ui",
        createdAt: 123,
        ops: [{ type: "insert" as const, start: 0, end: 0, text: "hello" }],
      },
    ],
  },
});

describe("functions api nullplug submit contracts", () => {
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
    bucket.seed(rootDropId, JSON.stringify({ content: "# Root" }));
    return bucket;
  };

  it("stores immutable UI response facts", async () => {
    const bucket = createSeededBucket();
    const fact = createFact();

    const response = await onRequest({
      request: createSubmitRequest(fact),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);

    const body = (await response.json()) as {
      stored: boolean;
      key: string;
      fact: typeof fact;
    };

    expect(response.status).toBe(200);
    expect(body.stored).toBe(true);
    expect(body.key).toBe(nullplugUiResponseFactKey(fact));
    await expect(bucket.get(body.key).then((object) => object?.json())).resolves.toEqual(
      fact,
    );
  });

  it("rejects duplicate response facts", async () => {
    const bucket = createSeededBucket();
    const fact = createFact();

    await onRequest({
      request: createSubmitRequest(fact),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    const duplicate = await onRequest({
      request: createSubmitRequest(fact),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);

    const body = (await duplicate.json()) as { code: string };
    expect(duplicate.status).toBe(409);
    expect(body.code).toBe("response_fact_exists");
  });

  it("rejects invalid facts and missing roots", async () => {
    const bucket = createSeededBucket();
    const invalid = await onRequest({
      request: createSubmitRequest({ ...createFact(), data: "not-an-object" }),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(invalid.status).toBe(400);

    const missingRoot = await onRequest({
      request: createSubmitRequest({
        ...createFact(),
        source: { rootDropId: "MissingRoot", branchId: "clone_anonymous" },
      }),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(missingRoot.status).toBe(404);
  });
});

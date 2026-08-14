import { createHash } from "node:crypto";
import { jest } from "@jest/globals";
import type { R2Bucket } from "@cloudflare/workers-types";
import { onRequest } from "../functions/api/nullplug/state";
import { NULLDOWN_ACCOUNT_ID_HEADER } from "../shared/drop/branch";
import {
  nullplugUiRuntimeFactId,
  nullplugUiStatePatchFactKey,
} from "../shared/nullplug/ui";
import {
  createBranchKey,
  createCheckpointKey,
} from "../functions/api/_lib/branches/storage/keys";
import { createBranchRuntimeFactLogRepository } from "../functions/api/_lib/branches/storage/runtimeFactLogRepository";

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

const rootDropId = "RootDrop1122";
const branchId = "clone_author";
const accountId = "acct-author";
const rootContent = "# Root";
const rootContentHash = `sha256:${createHash("sha256")
  .update(`nulldown.source-content.v1\n${rootContent}`)
  .digest("base64url")}`;

const createStateRequest = (body: unknown, requestAccountId = accountId): Request =>
  new Request("https://nulldown.test/api/nullplug/state", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [NULLDOWN_ACCOUNT_ID_HEADER]: requestAccountId,
    },
    body: JSON.stringify(body),
  });

const createPatchFact = () => ({
  version: 1 as const,
  kind: "ui.state.patch" as const,
  id: "patch-1",
  callId: "call-1",
  createdAt: 123,
  source: {
    rootDropId,
    branchId,
    snapshotId: 4,
    sourceContentHash: rootContentHash,
    callId: "call-1",
  },
  patch: [{ op: "set" as const, path: ["approved"], value: true }],
});

describe("functions api nullplug state contracts", () => {
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
    bucket.seed(rootDropId, JSON.stringify({ content: rootContent }));
    bucket.seed(
      createBranchKey(rootDropId, branchId),
      JSON.stringify({
        version: 1,
        branchId,
        rootDropId,
        baseDropId: rootDropId,
        mode: "clone",
        status: "active",
        ownerAccountId: "acct-owner",
        writerAccountId: accountId,
        writerClientId: "client-1",
        headSnapshotId: 0,
        headEventSeq: null,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    bucket.seed(
      createCheckpointKey(rootDropId, branchId, 0),
      rootContent,
      "text/plain",
    );
    return bucket;
  };

  it("stores immutable UI state facts", async () => {
    const bucket = createSeededBucket();
    const fact = createPatchFact();

    const response = await onRequest({
      request: createStateRequest(fact),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);

    const body = (await response.json()) as {
      stored: boolean;
      key: string;
      fact: typeof fact;
    };

    expect(response.status).toBe(200);
    expect(body.stored).toBe(true);
    expect(body.key).toBe(nullplugUiStatePatchFactKey(fact));
    await expect(bucket.get(body.key).then((object) => object?.json())).resolves.toEqual(
      body.fact,
    );
  });

  it("repairs duplicate state facts and keeps same ids distinct by call", async () => {
    const bucket = createSeededBucket();
    const fact = createPatchFact();

    await onRequest({
      request: createStateRequest(fact),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    const duplicate = await onRequest({
      request: createStateRequest(fact),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    const duplicateBody = (await duplicate.json()) as {
      duplicate: boolean;
      runtimeFact: { appended: boolean };
    };
    expect(duplicate.status).toBe(200);
    expect(duplicateBody).toMatchObject({
      duplicate: true,
      runtimeFact: expect.objectContaining({ appended: false }),
    });

    const otherCall = {
      ...fact,
      callId: "call-2",
      source: { ...fact.source, callId: "call-2" },
    };
    const second = await onRequest({
      request: createStateRequest(otherCall),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(second.status).toBe(200);

    const timeline = await createBranchRuntimeFactLogRepository({
      blobs: bucket as any,
    }).pollBranchRuntimeFactsSince(rootDropId, branchId, -1, 10);
    expect(timeline.facts.map((entry) => entry.factId)).toEqual([
      nullplugUiRuntimeFactId(fact),
      nullplugUiRuntimeFactId(otherCall),
    ]);
  });

  it("rejects invalid, stale, and missing-root state facts", async () => {
    const bucket = createSeededBucket();
    const fact = createPatchFact();

    const invalid = await onRequest({
      request: createStateRequest({ ...fact, patch: [{ op: "delete", path: [] }] }),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(invalid.status).toBe(400);

    const stale = await onRequest({
      request: createStateRequest({
        ...fact,
        id: "patch-stale-source",
        source: { ...fact.source, sourceContentHash: "sha256:stale" },
      }),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(stale.status).toBe(409);

    const missingRoot = await onRequest({
      request: createStateRequest({
        ...fact,
        id: "patch-missing-root",
        source: {
          rootDropId: "MissingRoot",
          branchId: "clone_anonymous",
          sourceContentHash: rootContentHash,
        },
      }),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(missingRoot.status).toBe(404);
  });

  it("requires an authenticated branch writer", async () => {
    const bucket = createSeededBucket();
    const fact = createPatchFact();
    const unauthenticated = await onRequest({
      request: new Request("https://nulldown.test/api/nullplug/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fact),
      }),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ACCOUNT_AUTH_SECRET: "production-secret",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(unauthenticated.status).toBe(401);

    const forbidden = await onRequest({
      request: createStateRequest(fact, "acct-other"),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(forbidden.status).toBe(403);
  });
});

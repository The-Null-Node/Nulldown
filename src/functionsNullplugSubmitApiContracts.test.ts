import { createHash } from "node:crypto";
import { jest } from "@jest/globals";
import type { R2Bucket } from "@cloudflare/workers-types";
import { onRequest } from "../functions/api/nullplug/submit";
import { onRequest as onResolvedQueryRequest } from "../functions/api/branches/[rootId]/[branchId]/resolved/query";
import { NULLDOWN_ACCOUNT_ID_HEADER } from "../shared/drop/branch";
import { RESOLVED_RUNTIME_REFS_RESOLVER_ID } from "../shared/drop/resolved/constants";
import { nullplugUiResponseFactKey } from "../shared/nullplug/ui";
import {
  createBranchKey,
  createCheckpointKey,
} from "../functions/api/_lib/branches/storage/keys";

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
    options: {
      prefix?: string;
      cursor?: string;
      limit?: number;
    } = {},
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
const branchContent = [
  "# Root",
  "",
  '```approval(id="approval-form")',
  "Approve?",
  "```",
].join("\n");
const branchContentHash = `sha256:${createHash("sha256")
  .update(`nulldown.source-content.v1\n${branchContent}`)
  .digest("base64url")}`;

const createSubmitRequest = (
  body: unknown,
  requestAccountId = accountId,
): Request =>
  new Request("https://nulldown.test/api/nullplug/submit", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [NULLDOWN_ACCOUNT_ID_HEADER]: requestAccountId,
    },
    body: JSON.stringify(body),
  });

const createFact = () => ({
  version: 1 as const,
  kind: "ui.response" as const,
  id: "response-1",
  primitiveId: "approval-form",
  createdAt: 123,
   source: {
     rootDropId,
     branchId,
     snapshotId: 4,
     sourceContentHash: branchContentHash,
   },
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
      branchContent,
      "text/plain",
    );
    return bucket;
  };

  it("stores immutable UI response facts", async () => {
    const bucket = createSeededBucket();
    const fact = createFact();

    const response = await onRequest({
      request: createSubmitRequest(fact),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);

    const body = (await response.json()) as {
      stored: boolean;
      indexed: boolean;
      key: string;
      fact: typeof fact;
    };

    expect(response.status).toBe(200);
    expect(body.stored).toBe(true);
    expect(body.indexed).toBe(true);
    expect(body.key).toBe(nullplugUiResponseFactKey(fact));
    await expect(
      bucket.get(body.key).then((object) => object?.json()),
    ).resolves.toEqual(body.fact);

    const queryResponse = await onResolvedQueryRequest({
      request: new Request(
        `https://nulldown.test/api/branches/${rootDropId}/${branchId}/resolved/query?resolverId=${RESOLVED_RUNTIME_REFS_RESOLVER_ID}&kind=ui.response&primitiveId=approval-form&q=approved%20true`,
      ),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { rootId: rootDropId, branchId },
    } as unknown as Parameters<typeof onResolvedQueryRequest>[0]);
    const queryBody = (await queryResponse.json()) as {
      nodes: Array<{
        node: { kind: string; primitiveId?: string; text: string };
      }>;
    };
    expect(queryResponse.status).toBe(200);
    expect(queryBody.nodes).toEqual([
      expect.objectContaining({
        node: expect.objectContaining({
          kind: "ui.response",
          primitiveId: "approval-form",
          text: expect.stringContaining("approved true"),
        }),
      }),
    ]);
  });

  it("repairs duplicate response facts", async () => {
    const bucket = createSeededBucket();
    const fact = createFact();

    await onRequest({
      request: createSubmitRequest(fact),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    const duplicate = await onRequest({
      request: createSubmitRequest(fact),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);

    const body = (await duplicate.json()) as {
      duplicate: boolean;
      runtimeFact: { appended: boolean };
    };
    expect(duplicate.status).toBe(200);
    expect(body).toMatchObject({
      duplicate: true,
      runtimeFact: expect.objectContaining({ appended: false }),
    });
  });

  it("rejects invalid facts and missing roots", async () => {
    const bucket = createSeededBucket();
    const invalid = await onRequest({
      request: createSubmitRequest({ ...createFact(), data: "not-an-object" }),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(invalid.status).toBe(400);

    const stale = await onRequest({
      request: createSubmitRequest({
        ...createFact(),
        id: "response-stale-source",
        source: {
          ...createFact().source,
          sourceContentHash: "sha256:stale",
        },
      }),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(stale.status).toBe(409);

    const missingRoot = await onRequest({
      request: createSubmitRequest({
        ...createFact(),
        source: { rootDropId: "MissingRoot", branchId },
      }),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(missingRoot.status).toBe(404);
  });

  it("requires an authenticated branch writer", async () => {
    const bucket = createSeededBucket();
    const unauthenticated = await onRequest({
      request: new Request("https://nulldown.test/api/nullplug/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createFact()),
      }),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ACCOUNT_AUTH_SECRET: "production-secret",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(unauthenticated.status).toBe(401);

    const forbidden = await onRequest({
      request: createSubmitRequest(createFact(), "acct-other"),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: {},
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(forbidden.status).toBe(403);
  });
});

import { createHash } from "node:crypto";
import { jest } from "@jest/globals";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { onRequest } from "../functions/api/diff/[id]";
import { createCloudflareVoidDataStore } from "../functions/api/_lib/core/platform/cloudflarePorts";
import { appendEventsToBranch } from "../functions/api/_lib/nulledit/service";
import { resolveBranchForActor } from "../functions/api/_lib/branches/lifecycle/service";
import {
  createResolvedHeapDataKey,
  type NulleditSnapshotDiffRefRecord,
  type NulleditSnapshotFrameRecord,
  type NulleditSnapshotter,
} from "./server/nulledit";
import {
  RESOLVED_DOCUMENT_RESOLVER_ID,
  type ResolvedDocumentNode,
  type ResolvedNulldownState,
} from "../shared/drop/resolved";

interface StoredObject {
  value: string;
  contentType: string;
  etag: string;
  uploaded: Date;
}

class MemoryR2Bucket {
  private readonly objects = new Map<string, StoredObject>();

  seed(key: string, value: string, contentType = "application/json"): string {
    const now = Date.now();
    const etag = this.createEtag(`${key}:${value}:${now}`);
    this.objects.set(key, {
      value,
      contentType,
      etag,
      uploaded: new Date(now),
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
    if (!existing) {
      return null;
    }

    return {
      key,
      etag: existing.etag,
      httpEtag: existing.etag,
      uploaded: existing.uploaded,
      size: existing.value.length,
      version: "v1",
      checksums: {
        md5: undefined,
        sha1: undefined,
        sha256: undefined,
        sha384: undefined,
        sha512: undefined,
      },
      httpMetadata: { contentType: existing.contentType },
      writeHttpMetadata: () => {},
      writeChecksums: () => {},
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
    const contentType =
      typeof options?.httpMetadata?.contentType === "string"
        ? options.httpMetadata.contentType
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

  async list(options?: {
    limit?: number;
    prefix?: string;
    cursor?: string;
    startAfter?: string;
  }): Promise<any> {
    const prefix = options?.prefix ?? "";
    const limit = Math.max(1, Math.min(1000, options?.limit ?? 1000));
    const startAfter = options?.startAfter ?? "";
    const startIndex = options?.cursor ? Number.parseInt(options.cursor, 10) : 0;

    const matching = [...this.objects.entries()]
      .map(([key, value]) => ({ key, value }))
      .filter((entry) => entry.key.startsWith(prefix))
      .filter((entry) => (startAfter ? entry.key > startAfter : true))
      .sort((a, b) => a.key.localeCompare(b.key));

    const page = matching.slice(startIndex, startIndex + limit);
    const nextOffset = startIndex + page.length;
    const truncated = nextOffset < matching.length;

    return {
      objects: page.map((entry) => ({
        key: entry.key,
        etag: entry.value.etag,
        httpEtag: entry.value.etag,
        uploaded: entry.value.uploaded,
        size: entry.value.value.length,
        version: "v1",
        checksums: {
          md5: undefined,
          sha1: undefined,
          sha256: undefined,
          sha384: undefined,
          sha512: undefined,
        },
        httpMetadata: { contentType: entry.value.contentType },
        customMetadata: {},
        range: undefined,
        writeHttpMetadata: () => {},
        writeChecksums: () => {},
      })),
      truncated,
      cursor: truncated ? String(nextOffset) : undefined,
      delimitedPrefixes: [],
    };
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

interface VoidDataRecordRow {
  namespace: string;
  collection: string;
  scope_key: string;
  id: string;
  record_json: string;
}

class MemoryD1Statement {
  private params: unknown[] = [];

  constructor(
    private readonly db: MemoryD1Database,
    private readonly sql: string,
  ) {}

  bind(...params: unknown[]) {
    this.params = params;
    return this;
  }

  async run() {
    this.db.run(this.sql, this.params);
    return { success: true };
  }

  async first<T>() {
    return this.db.first(this.sql, this.params) as T | null;
  }

  async all<T>() {
    return { results: this.db.all(this.sql, this.params) as T[] };
  }
}

class MemoryD1Database {
  private readonly records = new Map<string, VoidDataRecordRow>();

  prepare(sql: string) {
    return new MemoryD1Statement(this, sql);
  }

  private recordKey(namespace: unknown, collection: unknown, scopeKey: unknown, id: unknown): string {
    return `${String(namespace)}/${String(collection)}/${String(scopeKey)}/${String(id)}`;
  }

  run(sql: string, params: unknown[]): void {
    if (sql.includes("INSERT INTO void_data_records")) {
      this.records.set(this.recordKey(params[0], params[1], params[2], params[3]), {
        namespace: String(params[0]),
        collection: String(params[1]),
        scope_key: String(params[2]),
        id: String(params[3]),
        record_json: String(params[5]),
      });
      return;
    }

    if (sql.includes("DELETE FROM void_data_records")) {
      this.records.delete(this.recordKey(params[0], params[1], params[2], params[3]));
    }
  }

  first(sql: string, params: unknown[]): Record<string, unknown> | null {
    if (sql.includes("FROM void_data_records")) {
      return this.records.get(this.recordKey(params[0], params[1], params[2], params[3])) ?? null;
    }
    return null;
  }

  all(sql: string, params: unknown[]): Record<string, unknown>[] {
    if (!sql.includes("FROM void_data_records")) return [];
    const namespace = String(params[0]);
    const collection = sql.includes("collection = ?") ? String(params[1]) : null;
    const idPrefixParam = sql.includes("id LIKE ?")
      ? String(params[collection === null ? 1 : 2]).replace(/%$/, "")
      : null;
    const limit = Number(params[params.length - 2]);
    const offset = Number(params[params.length - 1]);

    return [...this.records.values()]
      .filter((row) => row.namespace === namespace)
      .filter((row) => (collection === null ? true : row.collection === collection))
      .filter((row) => (idPrefixParam === null ? true : row.id.startsWith(idPrefixParam)))
      .sort((left, right) =>
        `${left.namespace}/${left.collection}/${left.scope_key}/${left.id}`.localeCompare(
          `${right.namespace}/${right.collection}/${right.scope_key}/${right.id}`,
        ),
      )
      .slice(offset, offset + limit)
      .map((row) => ({ record_json: row.record_json }));
  }
}

const rootDropId = "AaBbCc112233";
const accountId = "acct_1";

const createPostRequest = (events: unknown): Request =>
  new Request(`https://nulldown.test/api/diff/${rootDropId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-nulldown-account-id": accountId,
    },
    body: JSON.stringify({ version: 1, events }),
  });

const createPostRequestWithClientHeader = (
  events: unknown,
  clientId: string,
): Request =>
  new Request(`https://nulldown.test/api/diff/${rootDropId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-nulldown-account-id": accountId,
      "x-nulldown-client-id": clientId,
    },
    body: JSON.stringify({ version: 1, events }),
  });

const createPostRequestWithPartialProviderHeaders = (
  events: unknown,
  clientId: string,
): Request =>
  new Request(`https://nulldown.test/api/diff/${rootDropId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-nulldown-account-id": accountId,
      "x-nulldown-client-id": clientId,
      "x-nulldown-timestamp": String(Date.now()),
    },
    body: JSON.stringify({ version: 1, events }),
  });

const createGetRequest = (query = ""): Request =>
  new Request(`https://nulldown.test/api/diff/${rootDropId}${query}`, {
    method: "GET",
    headers: {
      "x-nulldown-account-id": accountId,
    },
  });

const makeEvent = (input: {
  eventId: string;
  sourceClientId: string;
  text: string;
  createdAt: number;
  metadata?: unknown;
}) => ({
  eventId: input.eventId,
  seq: 0,
  dropId: rootDropId,
  sourceClientId: input.sourceClientId,
  createdAt: input.createdAt,
  ops: [
    {
      type: "insert" as const,
      start: 0,
      end: 0,
      text: input.text,
    },
  ],
  ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
});

describe("functions api diff contracts", () => {
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
      rootDropId,
      JSON.stringify({
        content: "",
        metadata: {
          ownerAccountId: accountId,
        },
      }),
      "application/json",
    );
    return bucket;
  };

  it("deduplicates repeat event ids across writes", async () => {
    const bucket = createSeededBucket();
    const event = makeEvent({
      eventId: "evt-1",
      sourceClientId: "writer-a",
      text: "hello",
      createdAt: 100,
    });

    const first = await onRequest({
      request: createPostRequest([event]),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    const firstBody = (await first.json()) as {
      accepted: number;
      totalStored: number;
    };

    const second = await onRequest({
      request: createPostRequest([event]),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    const secondBody = (await second.json()) as {
      accepted: number;
      totalStored: number;
    };

    expect(first.status).toBe(200);
    expect(firstBody.accepted).toBe(1);
    expect(firstBody.totalStored).toBe(1);

    expect(second.status).toBe(200);
    expect(secondBody.accepted).toBe(0);
    expect(secondBody.totalStored).toBe(1);
  });

  it("returns filtered diff pages with cursor", async () => {
    const bucket = createSeededBucket();
    const eventA = makeEvent({
      eventId: "evt-a",
      sourceClientId: "writer-a",
      text: "A",
      createdAt: 101,
    });
    const eventB = makeEvent({
      eventId: "evt-b",
      sourceClientId: "writer-b",
      text: "B",
      createdAt: 102,
    });

    const post = await onRequest({
      request: createPostRequest([eventA, eventB]),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(post.status).toBe(200);

    const latest = await onRequest({
      request: createGetRequest("?cursor=__latest__"),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    const latestBody = (await latest.json()) as {
      cursor: string | null;
      events: unknown[];
    };
    expect(latest.status).toBe(200);
    expect(latestBody.events).toHaveLength(0);
    expect(latestBody.cursor).toBe("1");

    const poll = await onRequest({
      request: createGetRequest("?cursor=-1&excludeClient=writer-a&limit=10"),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    const pollBody = (await poll.json()) as {
      cursor: string | null;
      events: Array<{ sourceClientId: string; eventId: string; seq: number }>;
    };

    expect(poll.status).toBe(200);
    expect(pollBody.events).toHaveLength(1);
    expect(pollBody.events[0].sourceClientId).toBe("writer-b");
    expect(pollBody.events[0].eventId).toBe("evt-b");
    expect(pollBody.cursor).toBe("1");
  });

  it("preserves event metadata through append and poll", async () => {
    const bucket = createSeededBucket();
    const event = makeEvent({
      eventId: "evt-metadata",
      sourceClientId: "writer-meta",
      text: "M",
      createdAt: 105,
      metadata: {
        kind: "nullplug.invoke",
        intent: "embed child plan",
        pluginId: "nd",
        args: {
          id: "child123",
          mode: "card",
        },
        labels: ["plan", "nullplug"],
        confidence: 0.9,
      },
    });

    const post = await onRequest({
      request: createPostRequest([event]),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);
    expect(post.status).toBe(200);

    const poll = await onRequest({
      request: createGetRequest("?cursor=-1&limit=10"),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    const pollBody = (await poll.json()) as {
      events: Array<{ metadata?: unknown }>;
    };

    expect(poll.status).toBe(200);
    expect(pollBody.events).toHaveLength(1);
    expect(pollBody.events[0].metadata).toEqual({
      kind: "nullplug.invoke",
      intent: "embed child plan",
      pluginId: "nd",
      args: {
        id: "child123",
        mode: "card",
      },
      labels: ["plan", "nullplug"],
      confidence: 0.9,
    });
  });

  it("persists built-in Nulledit snapshot records through data.put", async () => {
    const bucket = createSeededBucket();
    const db = new MemoryD1Database();
    const event = makeEvent({
      eventId: "evt-data-put",
      sourceClientId: "writer-data-put",
      text: "Persist me",
      createdAt: 106,
      metadata: {
        kind: "agent.edit",
        intent: "Persist snapshot frame and diff ref.",
        labels: ["data.put", "snapshotter"],
        confidence: 0.8,
      },
    });
    const waitUntilPromises: Promise<void>[] = [];

    const response = await onRequest({
      request: createPostRequest([event]),
      env: {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as unknown as D1Database,
      },
      params: { id: rootDropId },
      waitUntil: (promise: Promise<void>) => {
        waitUntilPromises.push(promise);
      },
    } as unknown as Parameters<typeof onRequest>[0]);
    const body = (await response.json()) as {
      branchId: string;
      snapshotId: number;
    };

    expect(response.status).toBe(200);
    expect(waitUntilPromises).toHaveLength(1);
    await Promise.all(waitUntilPromises);

    const data = createCloudflareVoidDataStore({
      R2_BUCKET: bucket as unknown as R2Bucket,
      DB: db as unknown as D1Database,
    });
    const frame = await data.get<NulleditSnapshotFrameRecord>({
      namespace: "nulledit",
      collection: "snapshot_frames",
      scope: { rootDropId, branchId: body.branchId },
      id: String(body.snapshotId),
    });
    const diffRef = await data.get<NulleditSnapshotDiffRefRecord>({
      namespace: "nulledit",
      collection: "snapshot_diff_refs",
      scope: {
        rootDropId,
        branchId: body.branchId,
        snapshotId: body.snapshotId,
      },
      id: event.eventId,
    });

    expect(frame).toEqual(
      expect.objectContaining({
        version: 1,
        rootDropId,
        branchId: body.branchId,
        snapshotId: body.snapshotId,
        content: "Persist me",
        textLength: "Persist me".length,
      }),
    );
    expect(frame?.acceptedDiffRefs).toEqual([
      {
        rootDropId,
        branchId: body.branchId,
        eventId: event.eventId,
        seq: 0,
        ref: `<diff:${event.eventId}>`,
        snapshotId: body.snapshotId,
      },
    ]);
    expect(diffRef).toEqual(
      expect.objectContaining({
        version: 1,
        rootDropId,
        branchId: body.branchId,
        snapshotId: body.snapshotId,
        sourceClientId: event.sourceClientId,
        metadata: event.metadata,
      }),
    );
    expect(diffRef?.ref).toEqual({
      rootDropId,
      branchId: body.branchId,
      eventId: event.eventId,
      seq: 0,
      ref: `<diff:${event.eventId}>`,
      snapshotId: body.snapshotId,
    });

    const resolvedHeap = await data.get<ResolvedNulldownState>(
      createResolvedHeapDataKey({
        rootDropId,
        branchId: body.branchId,
        snapshotId: body.snapshotId,
        resolverId: RESOLVED_DOCUMENT_RESOLVER_ID,
      }),
    );
    const resolvedNodes = await data.query<ResolvedDocumentNode>({
      namespace: "resolved",
      collection: "document_nodes",
      scope: {
        rootDropId,
        branchId: body.branchId,
        snapshotId: body.snapshotId,
        resolverId: RESOLVED_DOCUMENT_RESOLVER_ID,
      },
      indexes: [{ name: "kind", value: "paragraph" }],
      text: "Persist",
    });
    expect(resolvedHeap).toEqual(
      expect.objectContaining({
        rootDropId,
        branchId: body.branchId,
        snapshotId: body.snapshotId,
        resolverId: RESOLVED_DOCUMENT_RESOLVER_ID,
      }),
    );
    expect(resolvedHeap?.documentNodes?.length).toBeGreaterThan(0);
    expect(resolvedNodes).toEqual([
      expect.objectContaining({ kind: "paragraph", text: "Persist me" }),
    ]);
  });

  it("rejects invalid diff event metadata", async () => {
    const bucket = createSeededBucket();
    const event = makeEvent({
      eventId: "evt-invalid-metadata",
      sourceClientId: "writer-invalid-meta",
      text: "X",
      createdAt: 106,
      metadata: {
        kind: "invalid.kind",
      },
    });

    const response = await onRequest({
      request: createPostRequest([event]),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    const body = (await response.json()) as { code?: string };
    expect(response.status).toBe(400);
    expect(body.code).toBe("validation_failed");
  });

  it("accepts plain client id header without provider signature", async () => {
    const bucket = createSeededBucket();
    const event = makeEvent({
      eventId: "evt-client-only",
      sourceClientId: "writer-c",
      text: "C",
      createdAt: 103,
    });

    const response = await onRequest({
      request: createPostRequestWithClientHeader([event], "client-only-header"),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(200);
  });

  it("ignores partial provider auth headers for normal diff writes", async () => {
    const bucket = createSeededBucket();
    const event = makeEvent({
      eventId: "evt-partial-provider",
      sourceClientId: "writer-d",
      text: "D",
      createdAt: 104,
    });

    const response = await onRequest({
      request: createPostRequestWithPartialProviderHeaders(
        [event],
        "client-partial-provider",
      ),
      env: { R2_BUCKET: bucket as unknown as R2Bucket },
      params: { id: rootDropId },
    } as unknown as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(200);
  });

  it("runs Nulledit snapshotters after accepted writes", async () => {
    const bucket = createSeededBucket();
    const { branch } = await resolveBranchForActor(
      bucket as unknown as R2Bucket,
      rootDropId,
      accountId,
      null,
    );
    const event = makeEvent({
      eventId: "evt-observed",
      sourceClientId: "writer-observed",
      text: "O",
      createdAt: 107,
    });
    const calls: string[] = [];
    const waitUntilPromises: Promise<void>[] = [];
    const snapshotter: NulleditSnapshotter = {
      id: "snapshotter-1",
      snapshot(context) {
        for (const event of context.acceptedEvents) {
          calls.push(
            `event:${event.eventId}:${event.seq}:${context.branch.headSnapshotId}`,
          );
        }
        calls.push(
          `snapshot:${context.snapshotId}:${context.acceptedEvents.length}:${context.totalStored}`,
        );
      },
    };

    const appended = await appendEventsToBranch(
      bucket as unknown as R2Bucket,
      branch,
      [event],
      {
        snapshotters: [snapshotter],
        waitUntil: (promise) => {
          waitUntilPromises.push(promise);
        },
      },
    );

    expect(appended.acceptedEvents).toHaveLength(1);
    expect(appended.snapshot?.snapshotId).toBe(1);
    expect(waitUntilPromises).toHaveLength(1);
    await waitUntilPromises[0];
    expect(calls).toEqual(["event:evt-observed:0:1", "snapshot:1:1:1"]);
  });

  it("isolates Nulledit snapshotter failures", async () => {
    const bucket = createSeededBucket();
    const { branch } = await resolveBranchForActor(
      bucket as unknown as R2Bucket,
      rootDropId,
      accountId,
      null,
    );
    const event = makeEvent({
      eventId: "evt-observer-error",
      sourceClientId: "writer-observer-error",
      text: "E",
      createdAt: 108,
    });
    const errors: string[] = [];
    const waitUntilPromises: Promise<void>[] = [];

    const appended = await appendEventsToBranch(
      bucket as unknown as R2Bucket,
      branch,
      [event],
      {
        snapshotters: [
          {
            id: "bad-snapshotter",
            snapshot() {
              throw new Error("snapshotter failed");
            },
          },
        ],
        waitUntil: (promise) => {
          waitUntilPromises.push(promise);
        },
        onSnapshotterError: (_error, snapshotterId) => {
          errors.push(snapshotterId);
        },
      },
    );

    expect(appended.acceptedEvents).toHaveLength(1);
    await waitUntilPromises[0];
    expect(errors).toEqual(["bad-snapshotter"]);
  });
});

import { createHash } from "node:crypto";
import { jest } from "@jest/globals";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { onRequest } from "../functions/api/diff/[id]";
import { createCloudflareVoidDataStore } from "../functions/api/_lib/core/platform/cloudflarePorts";
import { createCloudflareVoidProvider } from "../functions/api/_lib/core/platform/cloudflareProvider";
import { appendEventsToBranch } from "../functions/api/_lib/nulledit/service";
import { resolveBranchForActor } from "../functions/api/_lib/branches/lifecycle/service";
import {
  readBranch,
  readSnapshot,
} from "../functions/api/_lib/branches/storage/repository";
import {
  createNulleditNullMemObserverSnapshotter,
  createNulleditPolicyDecisionFactDataKey,
  createNulleditPolicyObserverSnapshotter,
  createResolvedHeapDataKey,
  createInMemoryBranchCommitBuffer,
  type BranchCommitBuffer,
  type NulleditPolicyDecisionFactRecord,
  type NulleditSnapshotDiffRefRecord,
  type NulleditSnapshotFrameRecord,
  type NulleditSnapshotter,
} from "./server/nulledit";
import {
  RESOLVED_DOCUMENT_RESOLVER_ID,
  RESOLVED_RUNTIME_REFS_RESOLVER_ID,
} from "../shared/drop/resolved/constants";
import type {
  ResolvedDocumentNode,
  ResolvedNulldownState,
  ResolvedPriorityFactRecord,
  ResolvedRuntimeNode,
} from "../shared/drop/resolved/types";
import {
  nullplugUiResponseFactKey,
  type NullplugUiResponseFact,
} from "../shared/nullplug/ui";
import type { DropDiffEvent } from "../shared/drop/diff";
import type {
  NullMemFactRecord,
  NullMemProcedureRecord,
} from "../shared/nullmem/types";

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
  readonly priorityFacts = new Map<string, string>();
  readonly nullmemRecords = new Map<string, string>();
  readonly batchCalls: number[] = [];

  prepare(sql: string) {
    return new MemoryD1Statement(this, sql);
  }

  async batch(statements: MemoryD1Statement[]) {
    this.batchCalls.push(statements.length);
    return Promise.all(statements.map((statement) => statement.run()));
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

    if (sql.includes("INSERT INTO resolved_priority_facts")) {
      this.priorityFacts.set(String(params[5]), String(params[10]));
      return;
    }

    if (sql.includes("INSERT INTO nullmem_records")) {
      this.nullmemRecords.set(
        `${params[0]}/${params[1]}/${params[2]}/${params[3]}`,
        String(params[12]),
      );
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

  it("creates idempotent NullMem observer facts for accepted appends", async () => {
    const event = {
      ...makeEvent({
        eventId: "evt-nullmem-repeat",
        sourceClientId: "writer-nullmem-repeat",
        text: "M",
        createdAt: 115,
      }),
      seq: 7,
      snapshotId: 3,
    } as DropDiffEvent;
    const facts: Array<{ recordId: string }> = [];
    const byRecordId = new Map<string, string>();
    const snapshotter = createNulleditNullMemObserverSnapshotter({
      writeFact(fact) {
        facts.push(fact);
        byRecordId.set(fact.recordId, fact.text);
      },
    });
    const context = {
      data: {} as never,
      rootDropId,
      branchId: "branch-nullmem-repeat",
      snapshotId: 3,
      parentSnapshotId: 2,
      branch: {} as never,
      snapshot: {} as never,
      frame: { content: "M" },
      acceptedEvents: [event],
      acceptedDiffRefs: [],
      deduplicatedCount: 0,
      totalStored: 8,
    };

    await snapshotter.snapshot(context);
    await snapshotter.snapshot(context);

    expect(facts).toHaveLength(2);
    expect(facts[0]?.recordId).toBe(
      "memfact:observed-branch-append:AaBbCc112233:branch-nullmem-repeat:3:evt-nullmem-repeat:evt-nullmem-repeat",
    );
    expect(facts[1]?.recordId).toBe(facts[0]?.recordId);
    expect(byRecordId.size).toBe(1);
  });

  it("projects only explicit completed candidates as idempotent procedures", async () => {
    const candidate = {
      ...makeEvent({
        eventId: "evt-procedure-candidate",
        sourceClientId: "writer-procedure-candidate",
        text: "P",
        createdAt: 116,
        metadata: {
          intent: "Capture an accepted diff procedure.",
          args: {
            summary: "Apply the verified branch update.",
            procedureCandidate: {
              goal: "Apply a verified branch update",
              summary: "Persist the marked update and retain its diff evidence.",
              completed: true,
              reusableAs: "accepted-diff projection",
            },
          },
          labels: ["nullmem/procedure-candidate"],
          confidence: 0.8,
        },
      }),
      seq: 8,
      snapshotId: 4,
    } as DropDiffEvent;
    const ignored = {
      ...makeEvent({
        eventId: "evt-procedure-ignored",
        sourceClientId: "writer-procedure-ignored",
        text: "I",
        createdAt: 117,
        metadata: {
          labels: ["nullmem/procedure-candidate"],
          args: { procedureCandidate: { goal: "Missing completion", summary: "Ignore me" } },
        },
      }),
      seq: 9,
      snapshotId: 4,
    } as DropDiffEvent;
    const procedures: NullMemProcedureRecord[] = [];
    const snapshotter = createNulleditNullMemObserverSnapshotter({
      writeFact() {},
      writeProcedure(procedure) {
        procedures.push(procedure as NullMemProcedureRecord);
      },
    });
    const context = {
      data: {} as never,
      rootDropId,
      branchId: "branch-procedure-candidate",
      snapshotId: 4,
      parentSnapshotId: 3,
      branch: {} as never,
      snapshot: {} as never,
      frame: { content: "PI" },
      acceptedEvents: [candidate, ignored],
      acceptedDiffRefs: [],
      deduplicatedCount: 0,
      totalStored: 10,
    };

    await snapshotter.snapshot(context);
    await snapshotter.snapshot(context);

    expect(procedures).toHaveLength(2);
    expect(procedures[0]).toEqual(
      expect.objectContaining({
        recordId: `memproc:auto-accepted-diff:${rootDropId}:branch-procedure-candidate:evt-procedure-candidate`,
        goal: "Apply a verified branch update",
        outcome: "success",
        labels: ["procedure-memory", "auto-extracted", "needs-review", "accepted-diff"],
        confidence: 0.5,
        sourceRefs: [
          { kind: "branch", rootDropId, branchId: "branch-procedure-candidate" },
          {
            kind: "diff",
            rootDropId,
            branchId: "branch-procedure-candidate",
            eventId: "evt-procedure-candidate",
            seq: 8,
          },
        ],
      }),
    );
    expect(procedures[0]?.steps).toEqual([
      expect.objectContaining({
        kind: "diff.apply",
        status: "success",
        name: "Capture an accepted diff procedure.",
        argsSummary: "Apply the verified branch update.",
      }),
    ]);
    expect(procedures[1]?.recordId).toBe(procedures[0]?.recordId);
  });

  it("skips policy observer facts without accepted policy metadata", async () => {
    const event = {
      ...makeEvent({
        eventId: "evt-policy-skip",
        sourceClientId: "writer-policy-skip",
        text: "P",
        createdAt: 116,
      }),
      seq: 8,
      snapshotId: 4,
    } as DropDiffEvent;
    const writes: unknown[] = [];
    const snapshotter = createNulleditPolicyObserverSnapshotter();

    await snapshotter.snapshot({
      data: {
        putMany(records: unknown[]) {
          writes.push(...records);
        },
      } as never,
      rootDropId,
      branchId: "branch-policy-skip",
      snapshotId: 4,
      parentSnapshotId: 3,
      branch: {} as never,
      snapshot: {} as never,
      frame: { content: "P" },
      acceptedEvents: [event],
      acceptedDiffRefs: [],
      deduplicatedCount: 0,
      totalStored: 9,
    });

    expect(writes).toHaveLength(0);
  });

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

  it("persists built-in Nulledit snapshot records through the data store", async () => {
    const bucket = createSeededBucket();
    const db = new MemoryD1Database();
    const { branch } = await resolveBranchForActor(
      bucket as unknown as R2Bucket,
      rootDropId,
      accountId,
      null,
    );
    const responseFact: NullplugUiResponseFact = {
      version: 1,
      kind: "ui.response",
      id: "response-persist",
      primitiveId: "persist-action",
      createdAt: 105,
      source: {
        rootDropId,
        branchId: branch.branchId,
        snapshotId: 1,
        callId: "call-persist",
      },
      data: { persisted: true },
    };
    bucket.seed(nullplugUiResponseFactKey(responseFact), JSON.stringify(responseFact));
    const event = makeEvent({
      eventId: "evt-data-put",
      sourceClientId: "writer-data-put",
      text: "Persist me",
      createdAt: 106,
      metadata: {
        kind: "agent.edit",
        intent: "Persist snapshot frame and diff ref.",
        args: {
          priority: 4,
          summary: "Persist the verified snapshot projection.",
          procedureCandidate: {
            goal: "Persist a verified snapshot projection",
            summary: "Apply the marked diff and retain the immutable diff reference.",
            completed: true,
          },
        },
        labels: ["data.put", "snapshotter", "nullmem/procedure-candidate"],
        confidence: 0.8,
        policyDecisionRef: "policy-decision-persist",
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
    expect(db.batchCalls.some((count) => count > 8)).toBe(true);

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

    const runtimeHeap = await data.get<ResolvedNulldownState>(
      createResolvedHeapDataKey({
        rootDropId,
        branchId: body.branchId,
        snapshotId: body.snapshotId,
        resolverId: RESOLVED_RUNTIME_REFS_RESOLVER_ID,
      }),
    );
    const runtimeNodes = await data.query<ResolvedRuntimeNode>({
      namespace: "resolved",
      collection: "runtime_nodes",
      scope: {
        rootDropId,
        branchId: body.branchId,
        snapshotId: body.snapshotId,
        resolverId: RESOLVED_RUNTIME_REFS_RESOLVER_ID,
      },
      indexes: [{ name: "kind", value: "ui.response" }],
      text: "persist-action",
    });
    expect(runtimeHeap).toEqual(
      expect.objectContaining({
        rootDropId,
        branchId: body.branchId,
        snapshotId: body.snapshotId,
        resolverId: RESOLVED_RUNTIME_REFS_RESOLVER_ID,
      }),
    );
    expect(runtimeHeap?.runtimeNodes).toEqual([
      expect.objectContaining({
        kind: "ui.response",
        primitiveId: "persist-action",
      }),
    ]);
    expect(runtimeNodes).toEqual([
      expect.objectContaining({
        kind: "ui.response",
        primitiveId: "persist-action",
      }),
    ]);

    const priorityFacts = [...db.priorityFacts.values()].map(
      (entry) => JSON.parse(entry) as ResolvedPriorityFactRecord,
    );
    expect(priorityFacts).toEqual([
      expect.objectContaining({
        factId: `priority:diff:${rootDropId}:${body.branchId}:${event.eventId}`,
        rootDropId,
        branchId: body.branchId,
        targetKind: "diff",
        targetId: event.eventId,
        priority: 4,
        sourceSeq: 0,
        sourceEventId: event.eventId,
        reason: "Persist snapshot frame and diff ref.",
        labels: ["data.put", "snapshotter", "nullmem/procedure-candidate"],
      }),
    ]);

    const policyFact = await data.get<NulleditPolicyDecisionFactRecord>(
      createNulleditPolicyDecisionFactDataKey({
        rootDropId,
        branchId: body.branchId,
        snapshotId: body.snapshotId,
        factId: `policy:diff:${rootDropId}:${body.branchId}:${event.eventId}`,
      }),
    );
    const policyFacts = await data.query<NulleditPolicyDecisionFactRecord>({
      namespace: "nulledit",
      collection: "policy_decision_facts",
      scope: {
        rootDropId,
        branchId: body.branchId,
        snapshotId: body.snapshotId,
      },
    });
    expect(policyFact).toEqual(
      expect.objectContaining({
        version: 1,
        factId: `policy:diff:${rootDropId}:${body.branchId}:${event.eventId}`,
        rootDropId,
        branchId: body.branchId,
        snapshotId: body.snapshotId,
        sourceEventId: event.eventId,
        sourceSeq: 0,
        sourceClientId: event.sourceClientId,
        policyDecisionRef: "policy-decision-persist",
        metadataKind: "agent.edit",
        intent: "Persist snapshot frame and diff ref.",
        labels: ["data.put", "snapshotter", "nullmem/procedure-candidate"],
        confidence: 0.8,
        args: expect.objectContaining({ priority: 4 }),
        text: expect.stringContaining("policy-decision-persist"),
      }),
    );
    expect(policyFacts).toEqual([policyFact]);

    const nullmemRecords = [...db.nullmemRecords.values()].map(
      (entry) => JSON.parse(entry) as NullMemFactRecord | NullMemProcedureRecord,
    );
    const nullmemFacts = nullmemRecords.filter(
      (entry): entry is NullMemFactRecord => entry.kind === "fact",
    );
    const nullmemProcedures = nullmemRecords.filter(
      (entry): entry is NullMemProcedureRecord => entry.kind === "procedure",
    );
    expect(nullmemFacts).toEqual([
      expect.objectContaining({
        recordId: `memfact:observed-branch-append:${rootDropId}:${body.branchId}:${body.snapshotId}:${event.eventId}:${event.eventId}`,
        rootDropId,
        branchId: body.branchId,
        targetKind: "snapshot",
        targetId: String(body.snapshotId),
        labels: [
          "snapshotter/observable-chain",
          "nullmem/observed-append",
          "branch-append",
        ],
        metadata: expect.objectContaining({
          eventIds: [event.eventId],
          eventCount: 1,
          snapshotId: body.snapshotId,
          parentSnapshotId: 0,
          totalStored: 1,
          deduplicatedCount: 0,
          seqRange: { from: 0, to: 0 },
        }),
      }),
    ]);
    expect(nullmemFacts[0]?.sourceRefs).toEqual(
      expect.arrayContaining([
        { kind: "branch", rootDropId, branchId: body.branchId },
        {
          kind: "snapshot",
          rootDropId,
          branchId: body.branchId,
          snapshotId: body.snapshotId,
        },
        {
          kind: "diff",
          rootDropId,
          branchId: body.branchId,
          eventId: event.eventId,
          seq: 0,
        },
      ]),
    );
    expect(nullmemProcedures).toEqual([
      expect.objectContaining({
        recordId: `memproc:auto-accepted-diff:${rootDropId}:${body.branchId}:${event.eventId}`,
        goal: "Persist a verified snapshot projection",
        outcome: "success",
        labels: ["procedure-memory", "auto-extracted", "needs-review", "accepted-diff"],
        sourceRefs: [
          { kind: "branch", rootDropId, branchId: body.branchId },
          {
            kind: "diff",
            rootDropId,
            branchId: body.branchId,
            eventId: event.eventId,
            seq: 0,
          },
        ],
      }),
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
    const bufferedCommits: string[] = [];
    const commitBuffer: BranchCommitBuffer = {
      appendAcceptedCommit(commit) {
        bufferedCommits.push(
          `${commit.branchId}:${commit.snapshotId}:${commit.acceptedEvents.length}`,
        );
        return { mode: "write-through", reason: "cold-branch" };
      },
    };
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
        commitBuffer,
        waitUntil: (promise) => {
          waitUntilPromises.push(promise);
        },
      },
    );

    expect(appended.acceptedEvents).toHaveLength(1);
    expect(appended.snapshot?.snapshotId).toBe(1);
    expect(bufferedCommits).toEqual([`${branch.branchId}:1:1`]);
    expect(waitUntilPromises).toHaveLength(1);
    await waitUntilPromises[0];
    expect(calls).toEqual(["event:evt-observed:0:1", "snapshot:1:1:1"]);
  });

  it("runs Nulledit snapshotter phases in order", async () => {
    const bucket = createSeededBucket();
    const { branch } = await resolveBranchForActor(
      bucket as unknown as R2Bucket,
      rootDropId,
      accountId,
      null,
    );
    const event = makeEvent({
      eventId: "evt-phase-order",
      sourceClientId: "writer-phase-order",
      text: "P",
      createdAt: 111,
    });
    const calls: string[] = [];
    const waitUntilPromises: Promise<void>[] = [];
    const snapshotters: NulleditSnapshotter[] = [
      {
        id: "secondary-snapshotter",
        phase: "secondary",
        snapshot() {
          calls.push(`secondary:${calls.includes("primary:end")}`);
        },
      },
      {
        id: "extended-snapshotter",
        snapshot() {
          calls.push(`extended:${calls.includes("secondary:true")}`);
        },
      },
      {
        id: "primary-snapshotter",
        phase: "primary",
        async snapshot() {
          calls.push("primary:start");
          await Promise.resolve();
          calls.push("primary:end");
        },
      },
    ];

    const appended = await appendEventsToBranch(
      bucket as unknown as R2Bucket,
      branch,
      [event],
      {
        snapshotters,
        waitUntil: (promise) => {
          waitUntilPromises.push(promise);
        },
      },
    );

    expect(appended.acceptedEvents).toHaveLength(1);
    await waitUntilPromises[0];
    expect(calls).toEqual([
      "primary:start",
      "primary:end",
      "secondary:true",
      "extended:true",
    ]);
  });

  it("runs provider-registered snapshotters on future appends", async () => {
    const bucket = createSeededBucket();
    const db = new MemoryD1Database();
    const provider = createCloudflareVoidProvider({
      R2_BUCKET: bucket as unknown as R2Bucket,
      DB: db as unknown as D1Database,
    });
    const { branch } = await resolveBranchForActor(
      bucket as unknown as R2Bucket,
      rootDropId,
      accountId,
      null,
    );
    const event = makeEvent({
      eventId: "evt-provider-registered",
      sourceClientId: "writer-provider-registered",
      text: "R",
      createdAt: 112,
    });
    const calls: string[] = [];
    const waitUntilPromises: Promise<void>[] = [];
    const unsubscribe = provider.nulledit.registerSnapshotter({
      id: "provider-registered-snapshotter",
      phase: "secondary",
      snapshot(context) {
        calls.push(
          `${context.snapshotId}:${context.acceptedEvents[0]?.eventId}`,
        );
      },
    });

    try {
      const appended = await provider.nulledit.appendDiffEvents({
        branch,
        events: [event],
        waitUntil: (promise) => {
          waitUntilPromises.push(promise);
        },
      });

      expect(appended.acceptedEvents).toHaveLength(1);
      expect(waitUntilPromises).toHaveLength(1);
      await waitUntilPromises[0];
      expect(calls).toEqual(["1:evt-provider-registered"]);
    } finally {
      unsubscribe();
    }
  });

  it("buffers derived snapshotters after primary branch writes", async () => {
    const bucket = createSeededBucket();
    const { branch } = await resolveBranchForActor(
      bucket as unknown as R2Bucket,
      rootDropId,
      accountId,
      null,
    );
    const event = makeEvent({
      eventId: "evt-buffered",
      sourceClientId: "writer-buffered",
      text: "B",
      createdAt: 109,
    });
    const waitUntilPromises: Promise<void>[] = [];
    const calls: string[] = [];
    const commitBuffer: BranchCommitBuffer = {
      appendAcceptedCommit(commit) {
        calls.push(`buffer:${commit.snapshotId}:${commit.acceptedEvents.length}`);
        return {
          mode: "buffer",
          reason: "hot-branch",
          flushAfterMs: 100,
          bufferedEventCount: commit.acceptedEvents.length,
        };
      },
    };

    const appended = await appendEventsToBranch(
      bucket as unknown as R2Bucket,
      branch,
      [event],
      {
        snapshotters: [
          {
            id: "must-not-run",
            snapshot() {
              calls.push("snapshotter-ran");
            },
          },
        ],
        commitBuffer,
        waitUntil: (promise) => {
          waitUntilPromises.push(promise);
        },
      },
    );

    expect(appended.acceptedEvents).toHaveLength(1);
    expect(appended.snapshot?.snapshotId).toBe(1);
    expect(waitUntilPromises).toHaveLength(0);
    expect(calls).toEqual(["buffer:1:1"]);
    await expect(
      readBranch(bucket as unknown as R2Bucket, rootDropId, branch.branchId),
    ).resolves.toEqual(expect.objectContaining({ headSnapshotId: 1 }));
    await expect(
      readSnapshot(bucket as unknown as R2Bucket, rootDropId, branch.branchId, 1),
    ).resolves.toEqual(expect.objectContaining({ snapshotId: 1 }));
  });

  it("schedules buffered snapshotters when a flush threshold is reached", async () => {
    const bucket = createSeededBucket();
    const { branch } = await resolveBranchForActor(
      bucket as unknown as R2Bucket,
      rootDropId,
      accountId,
      null,
    );
    const event = makeEvent({
      eventId: "evt-threshold-flush",
      sourceClientId: "writer-threshold-flush",
      text: "F",
      createdAt: 110,
    });
    const commitBuffer = createInMemoryBranchCommitBuffer({
      thresholds: { hotBranchEventCount: 1, maxBufferedEventCount: 1 },
    });
    const waitUntilPromises: Promise<void>[] = [];
    const calls: string[] = [];

    const appended = await appendEventsToBranch(
      bucket as unknown as R2Bucket,
      branch,
      [event],
      {
        snapshotters: [
          {
            id: "threshold-snapshotter",
            snapshot(context) {
              calls.push(
                `${context.snapshotId}:${context.acceptedEvents[0]?.eventId}`,
              );
            },
          },
        ],
        commitBuffer,
        waitUntil: (promise) => {
          waitUntilPromises.push(promise);
        },
      },
    );

    expect(appended.acceptedEvents).toHaveLength(1);
    expect(appended.snapshot?.snapshotId).toBe(1);
    expect(waitUntilPromises).toHaveLength(1);
    await waitUntilPromises[0];
    expect(calls).toEqual(["1:evt-threshold-flush"]);
    expect(
      commitBuffer.flush?.({
        rootDropId,
        branchId: branch.branchId,
        reason: "manual",
      }),
    ).toEqual(expect.objectContaining({ commits: [], bufferedEventCount: 0 }));
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

  it("isolates accepted-diff procedure projection failures", async () => {
    const bucket = createSeededBucket();
    const { branch } = await resolveBranchForActor(
      bucket as unknown as R2Bucket,
      rootDropId,
      accountId,
      null,
    );
    const event = makeEvent({
      eventId: "evt-procedure-observer-error",
      sourceClientId: "writer-procedure-observer-error",
      text: "E",
      createdAt: 118,
      metadata: {
        labels: ["nullmem/procedure-candidate"],
        args: {
          procedureCandidate: {
            goal: "Exercise observer failure isolation",
            summary: "A failing procedure writer must not reject the accepted diff.",
            completed: true,
          },
        },
      },
    });
    const errors: string[] = [];
    const waitUntilPromises: Promise<void>[] = [];

    const appended = await appendEventsToBranch(
      bucket as unknown as R2Bucket,
      branch,
      [event],
      {
        snapshotters: [
          createNulleditNullMemObserverSnapshotter({
            writeFact() {},
            writeProcedure() {
              throw new Error("procedure projection failed");
            },
          }),
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
    expect(errors).toEqual(["nulledit.nullmem-observer"]);
  });
});

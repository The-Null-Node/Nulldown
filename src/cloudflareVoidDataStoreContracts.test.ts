import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { createHash } from "node:crypto";
import { createCloudflareVoidDataStore } from "../functions/api/_lib/core/platform/cloudflarePorts";
import { appendEventsToBranch } from "../functions/api/_lib/nulledit/service";
import { resolveBranchForActor } from "../functions/api/_lib/branches/lifecycle/service";
import { onRequestGet } from "../functions/api/branches/[rootId]/[branchId]/resolved/query";
import { ensureResolvedHeapProjection } from "../functions/api/_lib/resolved/heap/projector";
import { readResolvedHeapState } from "../functions/api/_lib/resolved/heap/state";
import { createNulleditResolvedDocumentSnapshotter } from "./server/nulledit/snapshotters/resolvedDocument";
import { createResolvedHeapDataKey } from "./server/nulledit/dataKeys/resolved";
import { heapifyResolvedDocument } from "../shared/drop/resolved/heapify/document";
import { RESOLVED_DOCUMENT_RESOLVER_ID, RESOLVED_RUNTIME_REFS_RESOLVER_ID } from "../shared/drop/resolved/constants";
import type { ResolvedNulldownState } from "../shared/drop/resolved/types";

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
      key,
      etag: existing.etag,
      httpEtag: existing.etag,
      uploaded: existing.uploaded,
      size: existing.value.length,
      httpMetadata: { contentType: existing.contentType },
      text: async () => existing.value,
      json: async <T>() => JSON.parse(existing.value) as T,
    };
  }

  async head(key: string): Promise<any> {
    const existing = this.objects.get(key);
    return existing ? { key, etag: existing.etag } : null;
  }

  async put(key: string, value: string, options?: any): Promise<any> {
    const existing = this.objects.get(key);
    if (options?.onlyIf?.etagDoesNotMatch === "*" && existing) return null;
    const uploaded = new Date();
    const next = {
      value,
      contentType: options?.httpMetadata?.contentType ?? "application/json",
      etag: createHash("sha1").update(`${key}:${value}`).digest("hex"),
      uploaded,
    };
    this.objects.set(key, next);
    return { key, etag: next.etag, uploaded, size: value.length };
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    list.forEach((key) => this.objects.delete(key));
  }

  async list(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<any> {
    const prefix = options?.prefix ?? "";
    const limit = Math.max(1, Math.min(1000, options?.limit ?? 1000));
    const offset = options?.cursor ? Number.parseInt(options.cursor, 10) : 0;
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort();
    const page = keys.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      objects: page.map((key) => ({ key, etag: this.objects.get(key)?.etag })),
      truncated: nextOffset < keys.length,
      cursor: nextOffset < keys.length ? String(nextOffset) : undefined,
    };
  }
}

interface DataRecordRow {
  namespace: string;
  collection: string;
  scope_key: string;
  id: string;
  key_json: string;
  record_json: string;
  content_type: string | null;
  updated_at: number;
}

interface DataIndexRow {
  namespace: string;
  collection: string;
  scope_key: string;
  id: string;
  name: string;
  mode: string;
  value_text: string | null;
  value_number: number | null;
  value_bool: number | null;
  updated_at: number;
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
  readonly records = new Map<string, DataRecordRow>();
  readonly indexes: DataIndexRow[] = [];
  readonly fts: Array<{
    namespace: string;
    collection: string;
    scope_key: string;
    id: string;
    text: string;
  }> = [];
  readonly batchCalls: number[] = [];

  prepare(sql: string) {
    return new MemoryD1Statement(this, sql);
  }

  async batch(statements: MemoryD1Statement[]) {
    this.batchCalls.push(statements.length);
    return Promise.all(statements.map((statement) => statement.run()));
  }

  private recordKey(
    namespace: unknown,
    collection: unknown,
    scopeKey: unknown,
    id: unknown,
  ): string {
    return `${String(namespace)}/${String(collection)}/${String(scopeKey)}/${String(id)}`;
  }

  run(sql: string, params: unknown[]): void {
    if (sql.includes("INSERT INTO void_data_records")) {
      this.records.set(
        this.recordKey(params[0], params[1], params[2], params[3]),
        {
          namespace: String(params[0]),
          collection: String(params[1]),
          scope_key: String(params[2]),
          id: String(params[3]),
          key_json: String(params[4]),
          record_json: String(params[5]),
          content_type: typeof params[6] === "string" ? params[6] : null,
          updated_at: Number(params[7]),
        },
      );
      return;
    }

    if (sql.includes("DELETE FROM void_data_indexes")) {
      const key = this.recordKey(params[0], params[1], params[2], params[3]);
      for (let index = this.indexes.length - 1; index >= 0; index -= 1) {
        const row = this.indexes[index];
        if (
          this.recordKey(
            row.namespace,
            row.collection,
            row.scope_key,
            row.id,
          ) === key
        ) {
          this.indexes.splice(index, 1);
        }
      }
      return;
    }

    if (sql.includes("DELETE FROM void_data_fts")) {
      const key = this.recordKey(params[0], params[1], params[2], params[3]);
      for (let index = this.fts.length - 1; index >= 0; index -= 1) {
        const row = this.fts[index];
        if (
          this.recordKey(
            row.namespace,
            row.collection,
            row.scope_key,
            row.id,
          ) === key
        ) {
          this.fts.splice(index, 1);
        }
      }
      return;
    }

    if (sql.includes("INSERT INTO void_data_indexes")) {
      this.indexes.push({
        namespace: String(params[0]),
        collection: String(params[1]),
        scope_key: String(params[2]),
        id: String(params[3]),
        name: String(params[4]),
        mode: String(params[5]),
        value_text: typeof params[6] === "string" ? params[6] : null,
        value_number: typeof params[7] === "number" ? params[7] : null,
        value_bool: typeof params[8] === "number" ? params[8] : null,
        updated_at: Number(params[9]),
      });
      return;
    }

    if (sql.includes("INSERT INTO void_data_fts")) {
      this.fts.push({
        text: String(params[0]),
        namespace: String(params[1]),
        collection: String(params[2]),
        scope_key: String(params[3]),
        id: String(params[4]),
      });
      return;
    }

    if (sql.includes("DELETE FROM void_data_records")) {
      this.records.delete(
        this.recordKey(params[0], params[1], params[2], params[3]),
      );
    }
  }

  first(sql: string, params: unknown[]): Record<string, unknown> | null {
    if (sql.includes("FROM void_data_records")) {
      return (
        (this.records.get(
          this.recordKey(params[0], params[1], params[2], params[3]),
        ) as unknown as Record<string, unknown> | undefined) ?? null
      );
    }
    return null;
  }

  all(sql: string, params: unknown[]): Record<string, unknown>[] {
    if (!sql.includes("FROM void_data_records")) return [];
    const namespace = String(params[0]);
    const collection = sql.includes("collection = ?")
      ? String(params[1])
      : null;
    const idPrefixParam = sql.includes("id LIKE ?")
      ? String(params[collection === null ? 1 : 2]).replace(/%$/, "")
      : null;
    const limit = Number(params[params.length - 2]);
    const offset = Number(params[params.length - 1]);

    return [...this.records.values()]
      .filter((row) => row.namespace === namespace)
      .filter((row) =>
        collection === null ? true : row.collection === collection,
      )
      .filter((row) =>
        idPrefixParam === null ? true : row.id.startsWith(idPrefixParam),
      )
      .sort((left, right) =>
        `${left.namespace}/${left.collection}/${left.scope_key}/${left.id}`.localeCompare(
          `${right.namespace}/${right.collection}/${right.scope_key}/${right.id}`,
        ),
      )
      .slice(offset, offset + limit)
      .map((row) => ({ record_json: row.record_json }));
  }
}

describe("Cloudflare VoidDataStore contracts", () => {
  it("connects a completed append snapshotter to the first and repeated Cloudflare query", async () => {
    const bucket = new MemoryR2Bucket();
    const db = new MemoryD1Database();
    const env = { R2_BUCKET: bucket as unknown as R2Bucket, DB: db as unknown as D1Database };
    const data = createCloudflareVoidDataStore(env);
    const rootDropId = "ProjectionRoot123";
    await bucket.put(rootDropId, JSON.stringify({ content: "", metadata: { ownerAccountId: "owner" } }));
    const { branch } = await resolveBranchForActor(env.R2_BUCKET, rootDropId, "owner", null);
    const pending: Promise<unknown>[] = [];
    const result = await appendEventsToBranch(env.R2_BUCKET, branch, [{
      eventId: "projection-event", seq: 0, dropId: rootDropId,
      sourceClientId: "test", createdAt: 123,
      ops: [{ type: "insert", start: 0, end: 0, text: "# Connected Projection\n\nAccepted content." }],
    }], { data, snapshotters: [createNulleditResolvedDocumentSnapshotter()], waitUntil: (task) => { pending.push(task); } });
    await Promise.all(pending);
    expect(result.acceptedEvents).toHaveLength(1);
    const state = await data.get<ResolvedNulldownState>(createResolvedHeapDataKey({
      rootDropId, branchId: branch.branchId, snapshotId: 1, resolverId: RESOLVED_DOCUMENT_RESOLVER_ID,
    }));
    expect(state?.sourceSeqRange).toEqual({ from: 0, to: 0 });
    expect(result.snapshot?.sourceContentHash).toBe(state?.sourceContentHash);
    // The producer has not populated the legacy reader's SQL/R2 projection.
    expect(await readResolvedHeapState(env, rootDropId, branch.branchId, RESOLVED_DOCUMENT_RESOLVER_ID, 1)).toBeNull();
    for (const override of [{ rootDropId: "other" }, { branchId: "other" }, { snapshotId: 2 }]) {
      expect(await data.get(createResolvedHeapDataKey({ ...state!, ...override }))).toBeNull();
    }
    const get = bucket.get.bind(bucket);
    let sourceReads = 0;
    bucket.get = async (key) => {
      if (key.startsWith("__drop_checkpoint__/") || key.startsWith("__drop_branch_diff")) {
        sourceReads++;
        throw new Error("Document projection must not replay content");
      }
      return get(key);
    };
    for (let i = 0; i < 2; i++) {
      const response = await onRequestGet({ env, params: { rootId: rootDropId, branchId: branch.branchId },
        request: new Request(`https://nulldown.test/api/branches/${rootDropId}/${branch.branchId}/resolved/query?q=Connected`),
      } as unknown as Parameters<typeof onRequestGet>[0]);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ heapGenerated: false, stale: false, snapshotId: 1 });
    }
    expect(sourceReads).toBe(0);
    expect([...db.records.values()].filter((row) => row.namespace === "resolved" && row.collection === "heaps")).toHaveLength(1);
  });

  it.each(["hash", "version", "root", "branch", "snapshot", "resolver", "shape", "unavailable"])(
    "rejects %s portable state and reuses the repaired legacy fallback",
    async (mismatch) => {
      const bucket = new MemoryR2Bucket();
      const data = createCloudflareVoidDataStore({ R2_BUCKET: bucket as unknown as R2Bucket, DB: new MemoryD1Database() as unknown as D1Database });
      const source = { rootDropId: "ProjectionRoot123", branchId: "owner", snapshotId: 1, content: "# Current content" };
      const state = await heapifyResolvedDocument(source);
      const key = createResolvedHeapDataKey(state);
      const invalid = { ...state };
      if (mismatch === "hash") invalid.sourceContentHash = (await heapifyResolvedDocument({ ...source, content: "old" })).sourceContentHash;
      if (mismatch === "version") invalid.resolverVersion = "old";
      if (mismatch === "root") invalid.rootDropId = "other";
      if (mismatch === "branch") invalid.branchId = "other";
      if (mismatch === "snapshot") invalid.snapshotId = 2;
      if (mismatch === "resolver") invalid.resolverId = RESOLVED_RUNTIME_REFS_RESOLVER_ID;
      await data.put(key, mismatch === "shape" ? { ...invalid, documentNodes: [{}] } : invalid);
      if (mismatch === "unavailable") data.get = async () => { throw new Error("offline"); };
      const env = { R2_BUCKET: bucket as unknown as R2Bucket, resolvedDocumentData: data };
      const read = () => ensureResolvedHeapProjection(env, state.resolverId, source, state.sourceContentHash);
      const repaired = await read();
      expect(repaired).toMatchObject({ heapGenerated: true, stale: false });
      expect(repaired.state?.documentNodes).toEqual(state.documentNodes);
      expect(await read()).toMatchObject({ heapGenerated: false, stale: false });
    },
  );

  it("never reads portable document storage for runtime projections", async () => {
    const bucket = new MemoryR2Bucket();
    let reads = 0;
    const source = { rootDropId: "ProjectionRoot123", branchId: "owner", snapshotId: 1, content: "# Runtime" };
    const state = await heapifyResolvedDocument(source);
    const env = { R2_BUCKET: bucket as unknown as R2Bucket,
      resolvedDocumentData: { get: async <T>() => { reads++; return state as T; } } };
    expect((await ensureResolvedHeapProjection(env, RESOLVED_RUNTIME_REFS_RESOLVER_ID, source, state.sourceContentHash)).heapGenerated).toBe(true);
    expect(reads).toBe(0);
  });
  it("reads and queries D1-backed records when R2 has no mirror", async () => {
    const bucket = new MemoryR2Bucket();
    const db = new MemoryD1Database();
    const data = createCloudflareVoidDataStore({
      R2_BUCKET: bucket as unknown as R2Bucket,
      DB: db as unknown as D1Database,
    });
    const key = {
      namespace: "nulledit",
      collection: "snapshot_diff_refs",
      scope: { rootDropId: "root-1", branchId: "owner", snapshotId: 1 },
      id: "evt-1",
    };
    const value = {
      eventId: "evt-1",
      text: "Important D1-backed snapshotter record",
    };

    await data.put(key, value, {
      indexes: [
        { name: "kind", value: "agent.edit" },
        { name: "labels", value: ["plan", "data.put"] },
        { name: "text", value: value.text, mode: "fulltext" },
      ],
    });
    await expect(bucket.list()).resolves.toEqual(
      expect.objectContaining({ objects: [] }),
    );

    const d1Only = createCloudflareVoidDataStore({
      R2_BUCKET: new MemoryR2Bucket() as unknown as R2Bucket,
      DB: db as unknown as D1Database,
    });

    await expect(d1Only.get(key)).resolves.toEqual(value);
    await expect(
      d1Only.list({
        namespace: "nulledit",
        collection: "snapshot_diff_refs",
        scope: { rootDropId: "root-1", branchId: "owner" },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        items: [expect.objectContaining({ value })],
        truncated: false,
      }),
    );
    await expect(
      d1Only.query({
        namespace: "nulledit",
        collection: "snapshot_diff_refs",
        scope: { rootDropId: "root-1", branchId: "owner", snapshotId: 1 },
        indexes: [{ name: "labels", value: "data.put" }],
        text: "snapshotter",
      }),
    ).resolves.toEqual([value]);
    expect(
      db.indexes.some(
        (entry) => entry.name === "labels" && entry.value_text === "data.put",
      ),
    ).toBe(true);
    expect(db.fts.some((entry) => entry.text.includes("snapshotter"))).toBe(
      true,
    );
  });

  it("keeps different scope value types isolated", async () => {
    const data = createCloudflareVoidDataStore({
      R2_BUCKET: new MemoryR2Bucket() as unknown as R2Bucket,
      DB: new MemoryD1Database() as unknown as D1Database,
    });
    const baseKey = {
      namespace: "resolved",
      collection: "document_nodes",
      id: "node-1",
    };
    const numericScopeKey = {
      ...baseKey,
      scope: { rootDropId: "root-1", snapshotId: 1 },
    };
    const stringScopeKey = {
      ...baseKey,
      scope: { rootDropId: "root-1", snapshotId: "1" },
    };

    await data.put(numericScopeKey, { source: "number" });
    await data.put(stringScopeKey, { source: "string" });

    await expect(data.get(numericScopeKey)).resolves.toEqual({
      source: "number",
    });
    await expect(data.get(stringScopeKey)).resolves.toEqual({
      source: "string",
    });
    await expect(
      data.list({
        namespace: "resolved",
        collection: "document_nodes",
        scope: { rootDropId: "root-1" },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({ value: { source: "number" } }),
          expect.objectContaining({ value: { source: "string" } }),
        ]),
        truncated: false,
      }),
    );
  });

  it("batches putMany records through D1 batch", async () => {
    const db = new MemoryD1Database();
    const data = createCloudflareVoidDataStore({
      R2_BUCKET: new MemoryR2Bucket() as unknown as R2Bucket,
      DB: db as unknown as D1Database,
    });

    await data.putMany([
      {
        key: {
          namespace: "resolved",
          collection: "document_nodes",
          scope: { rootDropId: "root-1", branchId: "owner", snapshotId: 1 },
          id: "node-a",
        },
        value: { kind: "paragraph", text: "Alpha batched node" },
        options: {
          indexes: [
            { name: "kind", value: "paragraph" },
            { name: "text", value: "Alpha batched node", mode: "fulltext" },
          ],
        },
      },
      {
        key: {
          namespace: "resolved",
          collection: "document_nodes",
          scope: { rootDropId: "root-1", branchId: "owner", snapshotId: 1 },
          id: "node-b",
        },
        value: { kind: "heading", text: "Beta batched node" },
        options: {
          indexes: [{ name: "kind", value: "heading" }],
        },
      },
    ]);

    expect(db.batchCalls).toHaveLength(1);
    expect(db.batchCalls[0]).toBeGreaterThan(2);
    await expect(
      data.query({
        namespace: "resolved",
        collection: "document_nodes",
        scope: { rootDropId: "root-1", branchId: "owner", snapshotId: 1 },
        indexes: [{ name: "kind", value: "paragraph" }],
        text: "alpha",
      }),
    ).resolves.toEqual([{ kind: "paragraph", text: "Alpha batched node" }]);
  });

  it("fails generic data operations clearly without D1", async () => {
    const data = createCloudflareVoidDataStore({
      R2_BUCKET: new MemoryR2Bucket() as unknown as R2Bucket,
    });
    const key = {
      namespace: "nulledit",
      collection: "snapshot_frames",
      scope: { rootDropId: "root-1", branchId: "owner" },
      id: "1",
    };

    await expect(data.get(key)).rejects.toThrow("void_data_store_db_required");
    await expect(data.put(key, { ok: true })).rejects.toThrow(
      "void_data_store_db_required",
    );
    await expect(data.delete(key)).rejects.toThrow(
      "void_data_store_db_required",
    );
    await expect(data.list({ namespace: "nulledit" })).rejects.toThrow(
      "void_data_store_db_required",
    );
    await expect(data.query({ namespace: "nulledit" })).rejects.toThrow(
      "void_data_store_db_required",
    );
  });
});

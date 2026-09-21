import { createResolvedHeapProjectionRepository } from "../functions/api/_lib/resolved/heap/projectionRepository";
import { ensureResolvedHeapProjection } from "../functions/api/_lib/resolved/heap/projector";
import { readResolvedHeapState } from "../functions/api/_lib/resolved/heap/state";
import { createBranchRuntimeFactLogRepository } from "../functions/api/_lib/branches/storage/runtime-fact-log";
import { putNullplugUiResponseFact } from "../functions/api/_lib/nullplug/facts/repository";
import {
  RESOLVED_DOCUMENT_RESOLVER_ID,
  RESOLVED_DOCUMENT_RESOLVER_VERSION,
  RESOLVED_RUNTIME_REFS_RESOLVER_ID,
} from "../shared/drop/resolved/constants";
import { heapifyResolvedDocument } from "../shared/drop/resolved/heapify/document";
import { heapifyResolvedRuntimeRefs } from "../shared/drop/resolved/heapify/runtimeRefs";
import { createResolvedHeapDeltaRecord } from "../shared/drop/resolved/nodeRefs";
import { writeResolvedNulldownState } from "../shared/drop/resolved/storage";
import type { ResolvedHeapDeltaRecord, ResolvedNulldownState } from "../shared/drop/resolved/types";
import type { BlobObjectStore, SqlBindableValue, SqlMetadataStore } from "./server/ports";

const source = {
  rootDropId: "projection-root",
  branchId: "owner",
  snapshotId: 0,
  content: "# Projection\n\nCurrent content.",
};

// A read-only SQL fixture deliberately returns payload rows in reverse order.
const projectionFixture = async (state: ResolvedNulldownState) => {
  const delta = (await createResolvedHeapDeltaRecord({ state, checkpointed: true }))!;
  const nodes = [...(state.documentNodes ?? []), ...(state.runtimeNodes ?? [])];
  const payloads = new Map(delta.nodeRefs!.map((ref, index) => [ref.nodeHash, JSON.stringify(nodes[index])]));
  const legacyNodes = new Map<string, string>();
  const queries: Array<{ sql: string; values: SqlBindableValue[] }> = [];
  const fixture = { delta: delta as ResolvedHeapDeltaRecord | null, legacyState: null as ResolvedNulldownState | null };
  const db: SqlMetadataStore = {
    prepare(sql) {
      let values: SqlBindableValue[] = [];
      const matchesTarget = () => JSON.stringify(values) === JSON.stringify([
        state.rootDropId, state.branchId, state.snapshotId, state.resolverId,
      ]);
      return {
        bind(...bindings) { values = bindings; return this; },
        async run() { throw new Error(`Unexpected write: ${sql}`); },
        async first<T>() {
          queries.push({ sql, values });
          if (sql.includes("FROM resolved_heap_deltas")) {
            return (matchesTarget() && fixture.delta ? { heap_delta_json: JSON.stringify(fixture.delta) } : null) as T | null;
          }
          if (sql.includes("FROM resolved_heaps")) {
            return (matchesTarget() && fixture.legacyState ? { state_json: JSON.stringify(fixture.legacyState) } : null) as T | null;
          }
          throw new Error(`Unexpected first: ${sql}`);
        },
        async all<T>() {
          queries.push({ sql, values });
          if (sql.includes("FROM resolved_node_payloads")) {
            expect(sql).toContain("node_hash IN (");
            expect(sql.match(/\?/g)).toHaveLength(values.length);
            expect(values.length).toBeLessThanOrEqual(100);
            return { results: [...payloads].reverse()
              .filter(([hash]) => values.includes(hash))
              .map(([node_hash, node_json]) => ({ node_hash, node_json })) as T[] };
          }
          if (sql.includes("FROM resolved_nodes")) {
            return { results: (matchesTarget() ? [...legacyNodes].reverse()
              .map(([node_id, node_json]) => ({ node_id, node_json })) : []) as T[] };
          }
          throw new Error(`Unexpected all: ${sql}`);
        },
      };
    },
  };
  const read = () => createResolvedHeapProjectionRepository({ sql: db }).readState(
    state.rootDropId, state.branchId!, state.resolverId, state.snapshotId!,
  );
  return { db, read, fixture, delta, payloads, legacyNodes, queries };
};

const memoryBlobs = (): BlobObjectStore => {
  const values = new Map<string, string>();
  const etags = new Map<string, string>();
  let revision = 0;
  return {
    async get(key) {
      const value = values.get(key);
      return value === undefined ? null : {
        key, etag: etags.get(key), text: async () => value, json: async <T>() => JSON.parse(value) as T,
      };
    },
    async put(key, value, options) {
      if (typeof value !== "string") throw new Error("Expected string blob");
      if (options?.onlyIf?.etagDoesNotMatch === "*" && values.has(key)) return null;
      if (options?.onlyIf?.etagMatches && options.onlyIf.etagMatches !== etags.get(key)) return null;
      values.set(key, value);
      etags.set(key, String(++revision));
      return { key, etag: etags.get(key) };
    },
    async head(key) { return values.has(key) ? { key, etag: etags.get(key) } : null; },
    async delete(keys) { for (const key of [keys].flat()) values.delete(key); },
    async list(options) {
      const keys = [...values.keys()].sort().filter((key) => key.startsWith(options?.prefix ?? ""));
      const offset = Number(options?.cursor ?? 0);
      const page = keys.slice(offset, offset + (options?.limit ?? 1000));
      const truncated = offset + page.length < keys.length;
      return { objects: page.map((key) => ({ key })), truncated,
        cursor: truncated ? String(offset + page.length) : undefined };
    },
  };
};

describe("resolved projection reuse contracts", () => {
  it("hydrates more than two chunks with ceil(unique hashes / 100) queries, preserving order and duplicates", async () => {
    const state = await heapifyResolvedDocument({
      ...source,
      content: Array.from({ length: 230 }, (_, i) => `Paragraph ${i}.`).join("\n\n"),
    });
    expect(state.documentNodes!.length).toBeGreaterThan(200);
    const fixture = await projectionFixture(state);
    fixture.delta.nodeRefs!.push(fixture.delta.nodeRefs![0], fixture.delta.nodeRefs![2]);
    const result = await fixture.read();
    expect(result?.documentNodes).toEqual([
      ...state.documentNodes!, state.documentNodes![0], state.documentNodes![2],
    ]);
    const reads = fixture.queries.filter(({ sql }) => sql.includes("FROM resolved_node_payloads"));
    expect(reads).toHaveLength(Math.ceil(fixture.payloads.size / 100));
    expect(reads.flatMap(({ values }) => values)).toHaveLength(fixture.payloads.size);
    expect(fixture.queries.some(({ sql }) => sql.includes("FROM resolved_nodes"))).toBe(false);
  });

  it("does not query payloads or legacy rows for empty refs", async () => {
    const state = { ...await heapifyResolvedDocument(source), documentNodes: [] };
    const fixture = await projectionFixture(state);
    expect((await fixture.read())?.documentNodes).toEqual([]);
    expect(fixture.queries.every(({ sql }) => sql.includes("FROM resolved_heap_deltas"))).toBe(true);
  });

  it.each(["missing", "invalid"])("falls back as a whole for %s payloads and preserves ref order and duplicates", async (mode) => {
    const state = await heapifyResolvedDocument(source);
    const fixture = await projectionFixture(state);
    const hash = fixture.delta.nodeRefs![0].nodeHash;
    if (mode === "missing") fixture.payloads.delete(hash);
    else fixture.payloads.set(hash, "{}");
    for (const node of state.documentNodes!) fixture.legacyNodes.set(node.id, JSON.stringify(node));
    fixture.delta.nodeRefs!.push(fixture.delta.nodeRefs![0]);
    expect((await fixture.read())?.documentNodes).toEqual([...state.documentNodes!, state.documentNodes![0]]);
    expect(fixture.queries.filter(({ sql }) => sql.includes("FROM resolved_nodes"))).toHaveLength(1);
  });

  it("rejects partial hydration, then uses full legacy state or R2 fallback", async () => {
    const state = await heapifyResolvedDocument(source);
    const fixture = await projectionFixture(state);
    fixture.payloads.clear();
    fixture.legacyNodes.set(state.documentNodes![0].id, JSON.stringify(state.documentNodes![0]));
    expect(await fixture.read()).toBeNull();
    fixture.fixture.legacyState = state;
    expect(await fixture.read()).toEqual(state);
    fixture.fixture.legacyState = null;
    const R2_BUCKET = memoryBlobs();
    await writeResolvedNulldownState(R2_BUCKET, state);
    expect(await readResolvedHeapState({ R2_BUCKET, DB: fixture.db }, source.rootDropId,
      source.branchId, state.resolverId, source.snapshotId)).toEqual(state);
  });

  it("hydrates runtime payloads using the runtime validator", async () => {
    const state = await heapifyResolvedRuntimeRefs({ ...source, content: "```nd(id=\"child-drop\")\n```" });
    expect(state.runtimeNodes!.length).toBeGreaterThan(0);
    const fixture = await projectionFixture(state);
    expect((await fixture.read())?.runtimeNodes).toEqual(state.runtimeNodes);
    expect(state.resolverId).toBe(RESOLVED_RUNTIME_REFS_RESOLVER_ID);
  });

  it("does not share projection state across store, branch, snapshot, or resolver targets", async () => {
    const state = await heapifyResolvedDocument(source);
    const fixture = await projectionFixture(state);
    await fixture.read();
    const repository = createResolvedHeapProjectionRepository({ sql: fixture.db });
    for (const [root, branch, resolver, snapshot] of [
      ["other-root", source.branchId, state.resolverId, 0],
      [source.rootDropId, "other-branch", state.resolverId, 0],
      [source.rootDropId, source.branchId, "other-resolver", 0],
      [source.rootDropId, source.branchId, state.resolverId, 1],
    ] as const) expect(await repository.readState(root, branch, resolver, snapshot)).toBeNull();
    const other = await projectionFixture(state);
    other.fixture.delta = null;
    expect(await other.read()).toBeNull();
  });

  it("reuses a current compact SQL projection without writing or loading the R2 fallback", async () => {
    const state = await heapifyResolvedDocument(source);
    const fixture = await projectionFixture(state);
    const R2_BUCKET = memoryBlobs();
    R2_BUCKET.get = async () => { throw new Error("Unexpected R2 fallback"); };
    const result = await ensureResolvedHeapProjection({ R2_BUCKET, DB: fixture.db },
      state.resolverId, source, state.sourceContentHash);
    expect(result).toMatchObject({ heapGenerated: false, stale: false,
      state: { resolverVersion: RESOLVED_DOCUMENT_RESOLVER_VERSION } });
    expect(result.state?.documentNodes).toEqual(state.documentNodes);
  });

  it("rebuilds a mismatched document resolver version and then reuses the current projection", async () => {
    const R2_BUCKET = memoryBlobs();
    const state = await heapifyResolvedDocument(source);
    await writeResolvedNulldownState(R2_BUCKET, {
      ...state, resolverVersion: `${RESOLVED_DOCUMENT_RESOLVER_VERSION}-old`,
    });
    const rebuilt = await ensureResolvedHeapProjection({ R2_BUCKET }, state.resolverId, source, state.sourceContentHash);
    expect(rebuilt).toMatchObject({ heapGenerated: true, stale: false,
      state: { resolverVersion: RESOLVED_DOCUMENT_RESOLVER_VERSION } });
    const reused = await ensureResolvedHeapProjection({ R2_BUCKET }, state.resolverId, source, state.sourceContentHash);
    expect(reused).toEqual({ ...rebuilt, heapGenerated: false });
  });

  it("revalidates content even when snapshot zero and resolver version are unchanged", async () => {
    const R2_BUCKET = memoryBlobs();
    const state = await heapifyResolvedDocument(source);
    await writeResolvedNulldownState(R2_BUCKET, state);
    const changed = { ...source, content: "# Changed root content" };
    const expected = await heapifyResolvedDocument(changed);
    const result = await ensureResolvedHeapProjection({ R2_BUCKET }, RESOLVED_DOCUMENT_RESOLVER_ID,
      changed, expected.sourceContentHash);
    expect(result.heapGenerated).toBe(true);
    expect(result.state?.sourceContentHash).toBe(expected.sourceContentHash);
    expect(result.state?.documentNodes).toEqual(expected.documentNodes);
  });

  it("checks the durable runtime cursor again on reuse and includes newly accepted facts", async () => {
    const R2_BUCKET = memoryBlobs();
    const state = await heapifyResolvedRuntimeRefs(source);
    const ensure = () => ensureResolvedHeapProjection({ R2_BUCKET }, state.resolverId, source, state.sourceContentHash);
    expect((await ensure()).heapGenerated).toBe(true);
    expect((await ensure()).heapGenerated).toBe(false);
    const fact = {
      version: 1 as const, kind: "ui.response" as const, id: "fresh-response",
      primitiveId: "approval", createdAt: 123,
      source: { rootDropId: source.rootDropId, branchId: source.branchId, snapshotId: 0 },
      data: { approved: true },
    };
    await putNullplugUiResponseFact(R2_BUCKET, fact);
    await createBranchRuntimeFactLogRepository({ blobs: R2_BUCKET }).appendBranchRuntimeFact(
      source.rootDropId, source.branchId, fact,
    );
    const refreshed = await ensure();
    expect(refreshed.heapGenerated).toBe(true);
    expect(refreshed.state?.sourceSeqRange?.to).toBe(0);
    expect(refreshed.state?.runtimeNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "ui.response", primitiveId: "approval" }),
    ]));
    expect((await ensure()).heapGenerated).toBe(false);
  });
});

import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { NULLDOWN_ACCOUNT_ID_HEADER, type DropBranchRecord, type DropSnapshotRecord } from "../shared/drop/branch";
import type { DropDiffEvent } from "../shared/drop/diff";
import type { NullplugUiResponseFact } from "../shared/nullplug/ui";
import { DROP_ENVELOPE_SCHEMA_V1 } from "../shared/drop/types";
import { toShortDropId } from "../shared/drop/id";
import { dropResolvedHeapKey } from "../shared/drop/sidecar";
import { createResolvedPriorityFact, deleteResolvedPriorityFact, listResolvedPriorityFacts, queryResolvedHeap } from "../functions/api/_lib/resolved/heap/service";
import { backfillD1Metadata } from "../functions/api/_lib/core/d1/backfillService";
import { putNullplugUiResponseFact, listNullplugRuntimeFacts } from "../functions/api/_lib/nullplug/facts/repository";
import {
  RESOLVED_DOCUMENT_RESOLVER_ID,
} from "../shared/drop/resolved";
import {
  readBranch,
  readSnapshot,
  writeBranch,
  writeSnapshot,
  writeSnapshotCheckpoint,
} from "../functions/api/_lib/branches/storage/repository";
import {
  pollBranchDiffEventsSince,
  readBranchDiffEventBySeq,
  writeBranchDiffEvent,
} from "../functions/api/_lib/branches/storage/diffLogRepository";

interface MemoryR2Object {
  key: string;
  body: string;
  uploaded: Date;
  httpMetadata?: { contentType?: string };
  etag: string;
}

class MemoryR2Bucket {
  private readonly objects = new Map<string, MemoryR2Object>();
  private revision = 0;

  async put(
    key: string,
    value: string,
    options?: {
      httpMetadata?: { contentType?: string };
      onlyIf?: { etagDoesNotMatch?: string; etagMatches?: string };
    },
  ) {
    const existing = this.objects.get(key);
    if (options?.onlyIf?.etagDoesNotMatch === "*" && existing) return null;
    if (
      options?.onlyIf?.etagMatches &&
      existing?.etag !== options.onlyIf.etagMatches
    ) {
      return null;
    }

    this.revision += 1;
    const object = {
      key,
      body: value,
      uploaded: new Date(1_700_000_000_000 + this.revision),
      httpMetadata: options?.httpMetadata,
      etag: `etag-${this.revision}`,
    };
    this.objects.set(key, object);
    return object;
  }

  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      ...object,
      text: async () => object.body,
      json: async <T = unknown>() => JSON.parse(object.body) as T,
      body: new Blob([object.body]).stream(),
    };
  }

  async head(key: string) {
    return this.objects.get(key) ?? null;
  }

  async delete(key: string) {
    this.objects.delete(key);
  }

  async list(options?: { prefix?: string; cursor?: string; limit?: number }) {
    const prefix = options?.prefix ?? "";
    const start = options?.cursor ? Number.parseInt(options.cursor, 10) : 0;
    const limit = options?.limit ?? 1000;
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort();
    const page = keys.slice(start, start + limit);
    const next = start + limit;
    return {
      objects: page.map((key) => this.objects.get(key) as MemoryR2Object),
      truncated: next < keys.length,
      cursor: next < keys.length ? String(next) : undefined,
    };
  }
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

  async first<T = Record<string, unknown>>() {
    return this.db.first(this.sql, this.params) as T | null;
  }

  async all<T = Record<string, unknown>>() {
    return { results: this.db.all(this.sql, this.params) as T[] };
  }
}

class MemoryD1Database {
  readonly branches = new Map<string, { record_json: string; created_at: number }>();
  readonly snapshots = new Map<string, { record_json: string; snapshot_id: number; created_at: number }>();
  readonly events = new Map<string, { event_json: string; seq: number; event_id: string; source_client_id: string }>();
  readonly facts = new Map<string, { fact_json: string; fact_kind: string; root_drop_id: string; branch_id: string; created_at: number }>();
  readonly heaps = new Map<string, { state_json: string }>();
  readonly nodes = new Map<string, { node_id: string; node_json: string; text: string }>();
  readonly heapDeltas = new Map<string, { heap_delta_json: string }>();
  readonly nodeRefs = new Map<string, { ref_json: string; node_hash: string }>();
  readonly nodePayloads = new Map<string, { node_json: string }>();
  readonly priorityFacts = new Map<string, { fact_json: string; root_drop_id: string; branch_id: string; resolver_id: string; created_at: number }>();
  readonly aliases = new Map<string, { full_id: string }>();
  readonly drops = new Map<string, { id: string; visibility: string }>();
  readonly publicDrops = new Map<string, { id: string; created_at: number; updated_at: number }>();
  readonly writers = new Map<string, { branch_id: string }>();

  prepare(sql: string) {
    return new MemoryD1Statement(this, sql);
  }

  async batch(statements: MemoryD1Statement[]) {
    return Promise.all(statements.map((statement) => statement.run()));
  }

  run(sql: string, params: unknown[]): void {
    if (sql.includes("INSERT INTO branches")) {
      this.branches.set(`${params[0]}/${params[1]}`, {
        record_json: String(params[14]),
        created_at: Number(params[12]),
      });
      return;
    }

    if (sql.includes("INSERT INTO drop_aliases")) {
      this.aliases.set(String(params[0]), { full_id: String(params[1]) });
      return;
    }

    if (sql.includes("INSERT INTO drops")) {
      this.drops.set(String(params[0]), {
        id: String(params[0]),
        visibility: String(params[5]),
      });
      return;
    }

    if (sql.includes("INSERT INTO public_drops")) {
      this.publicDrops.set(String(params[0]), {
        id: String(params[0]),
        created_at: Number(params[1]),
        updated_at: Number(params[2]),
      });
      return;
    }

    if (sql.includes("DELETE FROM public_drops")) {
      this.publicDrops.delete(String(params[0]));
      return;
    }

    if (sql.includes("INSERT INTO branch_writers")) {
      this.writers.set(`${params[0]}/${params[1]}`, { branch_id: String(params[2]) });
      return;
    }

    if (sql.includes("INSERT INTO branch_snapshots")) {
      this.snapshots.set(`${params[0]}/${params[1]}/${params[2]}`, {
        record_json: String(params[11]),
        snapshot_id: Number(params[2]),
        created_at: Number(params[10]),
      });
      return;
    }

    if (sql.includes("INSERT OR IGNORE INTO branch_events")) {
      const key = `${params[0]}/${params[1]}/${params[2]}`;
      if (!this.events.has(key)) {
        this.events.set(key, {
          event_json: String(params[7]),
          seq: Number(params[2]),
          event_id: String(params[3]),
          source_client_id: String(params[5]),
        });
      }
      return;
    }

    if (sql.includes("INSERT OR IGNORE INTO nullplug_facts")) {
      const key = `${params[0]}/${params[1]}/${params[2]}/${params[3]}/${params[4]}`;
      if (!this.facts.has(key)) {
        this.facts.set(key, {
          fact_json: String(params[6]),
          fact_kind: String(params[0]),
          root_drop_id: String(params[1]),
          branch_id: String(params[2]),
          created_at: Number(params[5]),
        });
      }
      return;
    }

    if (sql.includes("INSERT INTO resolved_heaps")) {
      this.heaps.set(`${params[0]}/${params[1]}/${params[2]}/${params[3]}`, {
        state_json: String(params[7]),
      });
      return;
    }

    if (sql.includes("INSERT INTO resolved_heap_deltas")) {
      this.heapDeltas.set(`${params[0]}/${params[1]}/${params[2]}/${params[3]}`, {
        heap_delta_json: String(params[12]),
      });
      return;
    }

    if (sql.includes("INSERT OR IGNORE INTO resolved_node_payloads")) {
      const key = String(params[0]);
      if (!this.nodePayloads.has(key)) {
        this.nodePayloads.set(key, { node_json: String(params[7]) });
      }
      return;
    }

    if (sql.includes("DELETE FROM resolved_node_refs")) {
      const prefix = `${params[0]}/${params[1]}/${params[2]}/${params[3]}/`;
      [...this.nodeRefs.keys()]
        .filter((key) => key.startsWith(prefix))
        .forEach((key) => this.nodeRefs.delete(key));
      return;
    }

    if (sql.includes("INSERT INTO resolved_node_refs")) {
      this.nodeRefs.set(`${params[0]}/${params[1]}/${params[2]}/${params[3]}/${params[4]}`, {
        node_hash: String(params[6]),
        ref_json: String(params[12]),
      });
      return;
    }

    if (sql.includes("INSERT INTO resolved_priority_facts")) {
      this.priorityFacts.set(String(params[5]), {
        root_drop_id: String(params[0]),
        branch_id: String(params[1]),
        resolver_id: String(params[2]),
        fact_json: String(params[10]),
        created_at: Number(params[7]),
      });
      return;
    }

    if (sql.includes("DELETE FROM resolved_priority_facts")) {
      const fact = this.priorityFacts.get(String(params[2]));
      if (fact?.root_drop_id === params[0] && fact.branch_id === params[1]) {
        this.priorityFacts.delete(String(params[2]));
      }
      return;
    }

    if (sql.includes("DELETE FROM resolved_nodes")) {
      const prefix = `${params[0]}/${params[1]}/${params[2]}/${params[3]}/`;
      [...this.nodes.keys()]
        .filter((key) => key.startsWith(prefix))
        .forEach((key) => this.nodes.delete(key));
      return;
    }

    if (sql.includes("INSERT INTO resolved_nodes")) {
      this.nodes.set(`${params[0]}/${params[1]}/${params[2]}/${params[3]}/${params[4]}`, {
        node_id: String(params[4]),
        node_json: String(params[10]),
        text: String(params[8]),
      });
    }
  }

  first(sql: string, params: unknown[]): Record<string, unknown> | null {
    if (sql.includes("FROM branches")) {
      return this.branches.get(`${params[0]}/${params[1]}`) ?? null;
    }

    if (sql.includes("FROM public_drops")) {
      return this.publicDrops.get(String(params[0])) ?? null;
    }

    if (sql.includes("FROM branch_snapshots")) {
      return this.snapshots.get(`${params[0]}/${params[1]}/${params[2]}`) ?? null;
    }

    if (sql.includes("FROM branch_events") && sql.includes("seq = ?")) {
      return this.events.get(`${params[0]}/${params[1]}/${params[2]}`) ?? null;
    }

    if (sql.includes("SELECT 1 AS found") && sql.includes("FROM branch_events")) {
      const found = [...this.events.values()].some(
        (event) =>
          event.event_id === params[2] &&
          this.events.has(`${params[0]}/${params[1]}/${event.seq}`),
      );
      return found ? { found: 1 } : null;
    }

    if (sql.includes("FROM resolved_heaps")) {
      return this.heaps.get(`${params[0]}/${params[1]}/${params[2]}/${params[3]}`) ?? null;
    }

    if (sql.includes("FROM resolved_heap_deltas")) {
      return this.heapDeltas.get(`${params[0]}/${params[1]}/${params[2]}/${params[3]}`) ?? null;
    }

    if (sql.includes("FROM resolved_priority_facts")) {
      const fact = this.priorityFacts.get(String(params[2]));
      if (fact?.root_drop_id === params[0] && fact.branch_id === params[1]) {
        return fact;
      }
      return null;
    }

    if (sql.includes("FROM resolved_node_payloads")) {
      return this.nodePayloads.get(String(params[0])) ?? null;
    }

    return null;
  }

  all(sql: string, params: unknown[]): Record<string, unknown>[] {
    if (sql.includes("FROM branch_snapshots")) {
      return [...this.snapshots.entries()]
        .filter(([key]) => key.startsWith(`${params[0]}/${params[1]}/`))
        .map(([, value]) => value)
        .sort((a, b) => a.snapshot_id - b.snapshot_id);
    }

    if (sql.includes("FROM branch_events")) {
      const rows = [...this.events.entries()]
        .filter(([key]) => key.startsWith(`${params[0]}/${params[1]}/`))
        .map(([, value]) => value)
        .sort((a, b) => a.seq - b.seq);
      if (!sql.includes("seq > ?")) return rows;

      const afterSeq = Number(params[2]);
      const hasExclude = sql.includes("source_client_id != ?");
      const excludeClient = hasExclude ? String(params[3]) : null;
      const limit = Number(hasExclude ? params[4] : params[3]);
      return rows
        .filter((row) => row.seq > afterSeq)
        .filter((row) => (excludeClient ? row.source_client_id !== excludeClient : true))
        .slice(0, limit);
    }

    if (sql.includes("FROM nullplug_facts")) {
      return [...this.facts.values()]
        .filter(
          (fact) =>
            fact.fact_kind === params[0] &&
            fact.root_drop_id === params[1] &&
            fact.branch_id === params[2],
        )
        .sort((a, b) => a.created_at - b.created_at);
    }

    if (sql.includes("FROM resolved_node_refs")) {
      return [...this.nodeRefs.entries()]
        .filter(([key]) => key.startsWith(`${params[0]}/${params[1]}/${params[2]}/${params[3]}/`))
        .map(([, value]) => value);
    }

    if (sql.includes("FROM resolved_nodes")) {
      return [...this.nodes.entries()]
        .filter(([key]) => key.startsWith(`${params[0]}/${params[1]}/${params[2]}/${params[3]}/`))
        .map(([, value]) => value);
    }

    if (sql.includes("FROM resolved_priority_facts")) {
      if (sql.includes("branch_id = ?") && !sql.includes("branch_id = ''")) {
        let bindingIndex = 2;
        const resolverId = sql.includes("resolver_id = ?")
          ? String(params[bindingIndex++])
          : null;
        const targetKind = sql.includes("target_kind = ?")
          ? String(params[bindingIndex++])
          : null;
        const targetId = sql.includes("target_id = ?")
          ? String(params[bindingIndex++])
          : null;
        const factId = sql.includes("fact_id = ?")
          ? String(params[bindingIndex++])
          : null;
        const limit = Number(params[bindingIndex]);
        return [...this.priorityFacts.entries()]
          .filter(([id]) => !factId || id === factId)
          .map(([, fact]) => ({
            fact,
            parsed: JSON.parse(fact.fact_json) as {
              targetKind?: string;
              targetId?: string;
            },
          }))
          .filter(({ fact }) => fact.root_drop_id === params[0] && fact.branch_id === params[1])
          .filter(({ fact }) => !resolverId || fact.resolver_id === resolverId)
          .filter(({ parsed }) => !targetKind || parsed.targetKind === targetKind)
          .filter(({ parsed }) => !targetId || parsed.targetId === targetId)
          .map(({ fact }) => fact)
          .sort((left, right) => right.created_at - left.created_at)
          .slice(0, limit);
      }

      return [...this.priorityFacts.values()]
        .filter(
          (fact) =>
            fact.root_drop_id === params[0] &&
            (fact.branch_id === "" || fact.branch_id === params[1]) &&
            (fact.resolver_id === "" || fact.resolver_id === params[2]),
        )
        .sort((left, right) => right.created_at - left.created_at);
    }

    return [];
  }
}

const createBranch = (overrides: Partial<DropBranchRecord> = {}): DropBranchRecord => ({
  version: 1,
  branchId: "owner",
  rootDropId: "drop_123456789",
  baseDropId: "drop_123456789",
  mode: "owner",
  status: "active",
  ownerAccountId: "acct_1",
  writerAccountId: "acct_1",
  writerClientId: "client_1",
  headSnapshotId: 0,
  snapshotHeapVersion: 2,
  headEventSeq: 0,
  checkpointInterval: 24,
  createdAt: 1000,
  updatedAt: 1000,
  ...overrides,
});

const createSnapshot = (overrides: Partial<DropSnapshotRecord> = {}): DropSnapshotRecord => {
  const snapshotId = overrides.snapshotId ?? 0;
  return {
    version: 1,
    snapshotId,
    rootDropId: "drop_123456789",
    branchId: "owner",
    parentSnapshotId: snapshotId === 0 ? null : snapshotId - 1,
    seq: snapshotId,
    eventIds: [],
    checkpointed: true,
    patchStartSeq: null,
    patchEndSeq: null,
    checkpointKey: `__drop_checkpoint__/drop_123456789/owner/${snapshotId}.txt`,
    textLength: 26,
    createdAt: 1000 + snapshotId,
    ...overrides,
  };
};

const createEvent = (): DropDiffEvent => ({
  eventId: "evt_1",
  seq: 0,
  dropId: "drop_123456789",
  sourceClientId: "client_1",
  createdAt: 1001,
  snapshotId: 1,
  ops: [{ type: "insert", start: 0, end: 0, text: "Hello" }],
});

describe("D1 metadata contracts", () => {
  it("reads branch, snapshot, and event metadata from D1 without R2 records", async () => {
    const bucket = new MemoryR2Bucket();
    const db = new MemoryD1Database();
    const branch = createBranch();
    const snapshot = createSnapshot();
    const event = createEvent();

    await writeBranch(bucket as unknown as R2Bucket, branch, db as unknown as D1Database);
    await writeSnapshot(bucket as unknown as R2Bucket, snapshot, db as unknown as D1Database);
    await writeBranchDiffEvent(
      bucket as unknown as R2Bucket,
      branch.rootDropId,
      branch.branchId,
      event,
      db as unknown as D1Database,
    );

    const emptyBucket = new MemoryR2Bucket();
    await expect(
      readBranch(emptyBucket as unknown as R2Bucket, branch.rootDropId, branch.branchId, db as unknown as D1Database),
    ).resolves.toEqual(branch);
    await expect(
      readSnapshot(emptyBucket as unknown as R2Bucket, snapshot.rootDropId, snapshot.branchId, snapshot.snapshotId, db as unknown as D1Database),
    ).resolves.toEqual(snapshot);
    await expect(
      readBranchDiffEventBySeq(emptyBucket as unknown as R2Bucket, event.dropId, branch.branchId, event.seq, db as unknown as D1Database),
    ).resolves.toEqual(event);

    const page = await pollBranchDiffEventsSince(
      emptyBucket as unknown as R2Bucket,
      branch.rootDropId,
      branch.branchId,
      -1,
      10,
      undefined,
      db as unknown as D1Database,
    );
    expect(page.events).toEqual([event]);
    expect(page.headSeq).toBe(0);
  });

  it("lists nullplug runtime facts from D1 without R2 records", async () => {
    const bucket = new MemoryR2Bucket();
    const db = new MemoryD1Database();
    const fact: NullplugUiResponseFact = {
      version: 1,
      kind: "ui.response",
      id: "response_1",
      primitiveId: "primitive_1",
      createdAt: 1002,
      source: { rootDropId: "drop_123456789", branchId: "owner" },
      data: { accepted: true },
    };

    await putNullplugUiResponseFact(
      bucket as unknown as R2Bucket,
      fact,
      db as unknown as D1Database,
    );

    const facts = await listNullplugRuntimeFacts(
      new MemoryR2Bucket() as unknown as R2Bucket,
      "drop_123456789",
      "owner",
      db as unknown as D1Database,
    );

    expect(facts.uiResponseFacts).toEqual([fact]);
    expect(facts.uiStatePatchFacts).toEqual([]);
    expect(facts.uiStateSnapshots).toEqual([]);
  });

  it("persists generated resolved heaps and nodes to D1", async () => {
    const bucket = new MemoryR2Bucket();
    const db = new MemoryD1Database();
    const branch = createBranch();
    const snapshot = createSnapshot();
    const content = "# D1 Test\n\nA searchable paragraph.";

    await writeBranch(bucket as unknown as R2Bucket, branch, db as unknown as D1Database);
    await writeSnapshot(bucket as unknown as R2Bucket, snapshot, db as unknown as D1Database);
    await writeSnapshotCheckpoint(
      bucket as unknown as R2Bucket,
      snapshot.rootDropId,
      snapshot.branchId,
      snapshot.snapshotId,
      content,
      snapshot.checkpointKey,
    );

    const response = await queryResolvedHeap(
      { R2_BUCKET: bucket as unknown as R2Bucket, DB: db as unknown as D1Database },
      { rootId: snapshot.rootDropId, branchId: snapshot.branchId },
      new Request("https://example.test/api/resolved/query?query=searchable"),
    );

    expect(response.status).toBe(200);
    expect(db.heaps.size).toBe(1);
    expect(db.nodes.size).toBeGreaterThan(0);
    expect(db.heapDeltas.size).toBe(1);
    expect(db.nodeRefs.size).toBe(db.nodes.size);
    expect(db.nodePayloads.size).toBe(db.nodes.size);
    const delta = JSON.parse([...db.heapDeltas.values()][0].heap_delta_json) as {
      version: number;
      checkpointed: boolean;
      nodeRefs: unknown[];
    };
    expect(delta).toEqual(expect.objectContaining({ version: 1, checkpointed: true }));
    expect(delta.nodeRefs.length).toBe(db.nodeRefs.size);

    await bucket.delete(
      dropResolvedHeapKey(
        snapshot.rootDropId,
        snapshot.branchId,
        RESOLVED_DOCUMENT_RESOLVER_ID,
        snapshot.snapshotId,
      ),
    );
    db.heaps.clear();

    const projectedResponse = await queryResolvedHeap(
      { R2_BUCKET: bucket as unknown as R2Bucket, DB: db as unknown as D1Database },
      { rootId: snapshot.rootDropId, branchId: snapshot.branchId },
      new Request("https://example.test/api/resolved/query?query=searchable"),
    );
    const projectedBody = (await projectedResponse.json()) as {
      heapGenerated: boolean;
      nodes: Array<{ node: { text: string } }>;
    };

    expect(projectedResponse.status).toBe(200);
    expect(projectedBody.heapGenerated).toBe(false);
    expect(projectedBody.nodes[0].node.text).toContain("searchable");
    expect(db.heaps.size).toBe(0);

    const prioritizedNode = [...db.nodes.values()]
      .map((entry) => JSON.parse(entry.node_json) as { id: string; kind: string; text: string })
      .find((node) => node.kind === "paragraph" && node.text.includes("searchable"));
    if (!prioritizedNode) throw new Error("Expected a searchable paragraph node.");
    const factResponse = await createResolvedPriorityFact(
      { R2_BUCKET: bucket as unknown as R2Bucket, DB: db as unknown as D1Database },
      { rootId: snapshot.rootDropId, branchId: snapshot.branchId },
      new Request("https://example.test/api/resolved/priority", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [NULLDOWN_ACCOUNT_ID_HEADER]: branch.writerAccountId ?? "acct_1",
        },
        body: JSON.stringify({
          targetKind: "node",
          targetId: prioritizedNode.id,
          priority: 3,
          reason: "Prioritize the paragraph for the agent.",
        }),
      }),
    );
    expect(factResponse.status).toBe(201);
    const factBody = (await factResponse.json()) as {
      fact: { factId: string; targetId: string };
    };
    expect(factBody.fact.targetId).toBe(prioritizedNode.id);
    expect(db.priorityFacts.size).toBe(1);

    const listResponse = await listResolvedPriorityFacts(
      { R2_BUCKET: bucket as unknown as R2Bucket, DB: db as unknown as D1Database },
      { rootId: snapshot.rootDropId, branchId: snapshot.branchId },
      new Request("https://example.test/api/resolved/priority?targetKind=node", {
        headers: { [NULLDOWN_ACCOUNT_ID_HEADER]: branch.writerAccountId ?? "acct_1" },
      }),
    );
    const listBody = (await listResponse.json()) as {
      facts: Array<{ factId: string }>;
    };
    expect(listResponse.status).toBe(200);
    expect(listBody.facts.map((fact) => fact.factId)).toEqual([
      factBody.fact.factId,
    ]);

    const priorityResponse = await queryResolvedHeap(
      { R2_BUCKET: bucket as unknown as R2Bucket, DB: db as unknown as D1Database },
      { rootId: snapshot.rootDropId, branchId: snapshot.branchId },
      new Request("https://example.test/api/resolved/query?top=1"),
    );
    const priorityBody = (await priorityResponse.json()) as {
      heapGenerated: boolean;
      nodes: Array<{ node: { id: string }; reasons: string[] }>;
    };

    expect(priorityResponse.status).toBe(200);
    expect(priorityBody.heapGenerated).toBe(false);
    expect(priorityBody.nodes[0].node.id).toBe(prioritizedNode.id);
    expect(priorityBody.nodes[0].reasons).toContain("priority-fact");

    const deleteResponse = await deleteResolvedPriorityFact(
      { R2_BUCKET: bucket as unknown as R2Bucket, DB: db as unknown as D1Database },
      {
        rootId: snapshot.rootDropId,
        branchId: snapshot.branchId,
        factId: encodeURIComponent(factBody.fact.factId),
      },
      new Request(
        `https://example.test/api/resolved/priority/${encodeURIComponent(factBody.fact.factId)}`,
        {
          method: "DELETE",
          headers: { [NULLDOWN_ACCOUNT_ID_HEADER]: branch.writerAccountId ?? "acct_1" },
        },
      ),
    );
    const deleteBody = (await deleteResponse.json()) as { deleted: boolean };
    expect(deleteResponse.status).toBe(200);
    expect(deleteBody.deleted).toBe(true);
    expect(db.priorityFacts.size).toBe(0);
  });

  for (const headEventSeq of [null, -1] as const) {
    it(`generates snapshot 0 resolved heaps when head event seq is ${headEventSeq}`, async () => {
      const bucket = new MemoryR2Bucket();
      const db = new MemoryD1Database();
      const branch = createBranch({ headEventSeq });
      const snapshot = createSnapshot();
      const content = "# Empty Branch\n\nInitial content.";

      await writeBranch(bucket as unknown as R2Bucket, branch, db as unknown as D1Database);
      await writeSnapshot(bucket as unknown as R2Bucket, snapshot, db as unknown as D1Database);
      await writeSnapshotCheckpoint(
        bucket as unknown as R2Bucket,
        snapshot.rootDropId,
        snapshot.branchId,
        snapshot.snapshotId,
        content,
        snapshot.checkpointKey,
      );

      const response = await queryResolvedHeap(
        { R2_BUCKET: bucket as unknown as R2Bucket, DB: db as unknown as D1Database },
        { rootId: snapshot.rootDropId, branchId: snapshot.branchId },
        new Request("https://example.test/api/resolved/query?snapshotId=0&query=initial"),
      );
      const body = (await response.json()) as {
        heapGenerated: boolean;
        sourceContentHash?: string;
        nodes?: Array<{ node: { text: string } }>;
      };

      expect(response.status).toBe(200);
      expect(body.heapGenerated).toBe(true);
      expect(body.sourceContentHash).toMatch(/^sha256:/);
      expect(body.nodes?.some((entry) => entry.node.text.includes("Initial"))).toBe(true);
    });
  }

  it("materializes compact v2 resolved heaps by walking parent deltas", async () => {
    const bucket = new MemoryR2Bucket();
    const db = new MemoryD1Database();
    const branch = createBranch({ headSnapshotId: 2, headEventSeq: 2 });
    const snapshots = [
      createSnapshot({ snapshotId: 0, textLength: 24 }),
      createSnapshot({ snapshotId: 1, textLength: 28 }),
      createSnapshot({ snapshotId: 2, textLength: 30 }),
    ];
    const contents = [
      "# Chain\n\nAlpha paragraph.",
      "# Chain\n\nBeta paragraph.",
      "# Chain\n\nFinal compact paragraph.",
    ];

    await writeBranch(bucket as unknown as R2Bucket, branch, db as unknown as D1Database);
    for (const [index, snapshot] of snapshots.entries()) {
      await writeSnapshot(bucket as unknown as R2Bucket, snapshot, db as unknown as D1Database);
      await writeSnapshotCheckpoint(
        bucket as unknown as R2Bucket,
        snapshot.rootDropId,
        snapshot.branchId,
        snapshot.snapshotId,
        contents[index],
        snapshot.checkpointKey,
      );
      const response = await queryResolvedHeap(
        { R2_BUCKET: bucket as unknown as R2Bucket, DB: db as unknown as D1Database },
        { rootId: snapshot.rootDropId, branchId: snapshot.branchId },
        new Request(`https://example.test/api/resolved/query?snapshotId=${snapshot.snapshotId}&query=Chain`),
      );
      expect(response.status).toBe(200);
    }

    const deltas = [...db.heapDeltas.values()]
      .map((entry) => JSON.parse(entry.heap_delta_json) as {
        snapshotId: number;
        checkpointed: boolean;
        nodeRefs?: unknown[];
        nodeOps?: Array<{ op: string }>;
      })
      .sort((left, right) => left.snapshotId - right.snapshotId);
    expect(deltas.map((delta) => delta.checkpointed)).toEqual([true, false, false]);
    expect(deltas[1].nodeRefs).toBeUndefined();
    expect(deltas[1].nodeOps?.some((op) => op.op === "upsert")).toBe(true);
    expect(deltas[1].nodeOps?.some((op) => op.op === "delete")).toBe(true);

    for (const snapshot of snapshots) {
      await bucket.delete(
        dropResolvedHeapKey(
          snapshot.rootDropId,
          snapshot.branchId,
          RESOLVED_DOCUMENT_RESOLVER_ID,
          snapshot.snapshotId,
        ),
      );
    }
    db.heaps.clear();

    const compactResponse = await queryResolvedHeap(
      { R2_BUCKET: bucket as unknown as R2Bucket, DB: db as unknown as D1Database },
      { rootId: branch.rootDropId, branchId: branch.branchId },
      new Request("https://example.test/api/resolved/query?snapshotId=2&query=final&top=10"),
    );
    const compactBody = (await compactResponse.json()) as {
      heapGenerated: boolean;
      nodes: Array<{ node: { text: string } }>;
    };

    expect(compactResponse.status).toBe(200);
    expect(compactBody.heapGenerated).toBe(false);
    expect(compactBody.nodes.some((entry) => entry.node.text.includes("Final compact"))).toBe(true);
    expect(compactBody.nodes.some((entry) => entry.node.text.includes("Alpha"))).toBe(false);
  });

  it("backfills R2 drop and branch metadata into D1", async () => {
    const bucket = new MemoryR2Bucket();
    const db = new MemoryD1Database();
    const branch = createBranch();
    const rootDropId = branch.rootDropId;

    await bucket.put(
      rootDropId,
      JSON.stringify({
        schema: DROP_ENVELOPE_SCHEMA_V1,
        version: 1,
        createdAt: 1000,
        accountId: "acct_1",
        visibility: "public",
        metadata: { topic: "d1" },
        cipher: { alg: "A256GCM", iv: "iv", ciphertext: "ciphertext" },
        keyEnvelope: {
          mode: "account-vault-rsa-oaep",
          kid: "kid_1",
          wrappedKey: "wrapped",
        },
        signatures: {
          device: { kid: "kid_1", alg: "ECDSA_P256_SHA256", sig: "sig" },
        },
      }),
      { httpMetadata: { contentType: "application/json" } },
    );
    await writeBranch(bucket as unknown as R2Bucket, branch);
    await bucket.put(
      `__drop_writer_branch__/${rootDropId}/account:acct_1.txt`,
      branch.branchId,
      { httpMetadata: { contentType: "text/plain" } },
    );

    const response = await backfillD1Metadata(
      {
        R2_BUCKET: bucket as unknown as R2Bucket,
        DB: db as unknown as D1Database,
        METADATA_BACKFILL_TOKEN: "secret",
      },
      new Request("https://example.test/api/metadata/backfill?limit=20", {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
      }),
    );
    const body = (await response.json()) as { stats: Record<string, number> };

    expect(response.status).toBe(200);
    expect(body.stats.dropsUpserted).toBe(1);
    expect(body.stats.branchesUpserted).toBe(1);
    expect(body.stats.writerPointersUpserted).toBe(1);
    expect(db.aliases.get(toShortDropId(rootDropId))?.full_id).toBe(rootDropId);
    expect(db.drops.get(rootDropId)?.visibility).toBe("public");
    expect(db.publicDrops.has(rootDropId)).toBe(true);
    expect(db.branches.has(`${rootDropId}/${branch.branchId}`)).toBe(true);
    expect(db.writers.get(`${rootDropId}/account:acct_1`)?.branch_id).toBe(
      branch.branchId,
    );
  });
});

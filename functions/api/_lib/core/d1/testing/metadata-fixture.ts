import type { DropBranchRecord, DropSnapshotRecord } from "../../../../../../shared/drop/branch";
import type { DropDiffEvent } from "../../../../../../shared/drop/diff";

interface MemoryR2Object {
  key: string;
  body: string;
  uploaded: Date;
  httpMetadata?: { contentType?: string };
  etag: string;
}

export class MemoryR2Bucket {
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

export class MemoryD1Database {
  readonly sqlLog: string[] = [];
  readonly branches = new Map<
    string,
    { record_json: string; created_at: number }
  >();
  readonly snapshots = new Map<
    string,
    { record_json: string; snapshot_id: number; created_at: number }
  >();
  readonly events = new Map<
    string,
    {
      event_json: string;
      seq: number;
      event_id: string;
      source_client_id: string;
    }
  >();
  readonly facts = new Map<
    string,
    {
      fact_json: string;
      fact_kind: string;
      root_drop_id: string;
      branch_id: string;
      created_at: number;
    }
  >();
  readonly heaps = new Map<string, { state_json: string }>();
  readonly nodes = new Map<
    string,
    { node_id: string; node_json: string; text: string }
  >();
  readonly heapDeltas = new Map<string, { heap_delta_json: string }>();
  readonly nodeRefs = new Map<
    string,
    { ref_json: string; node_hash: string }
  >();
  readonly nodePayloads = new Map<string, { node_json: string }>();
  readonly priorityFacts = new Map<
    string,
    {
      fact_json: string;
      root_drop_id: string;
      branch_id: string;
      resolver_id: string;
      created_at: number;
    }
  >();
  readonly nullmemRecords = new Map<
    string,
    {
      record_json: string;
      root_drop_id: string;
      branch_id: string;
      record_kind: string;
      created_at: number;
      priority: number;
    }
  >();
  readonly aliases = new Map<string, { full_id: string }>();
  readonly drops = new Map<
    string,
    { id: string; visibility: string; owner_account_id: string | null }
  >();
  readonly accounts = new Map<
    string,
    {
      account_id: string;
      signing_public_jwk: string;
      encryption_kid: string | null;
      encryption_public_jwk: string | null;
      created_at: number;
      updated_at: number;
    }
  >();
  readonly publicDrops = new Map<
    string,
    { id: string; created_at: number; updated_at: number }
  >();
  readonly writers = new Map<string, { branch_id: string }>();

  prepare(sql: string) {
    return new MemoryD1Statement(this, sql);
  }

  async batch(statements: MemoryD1Statement[]) {
    return Promise.all(statements.map((statement) => statement.run()));
  }

  run(sql: string, params: unknown[]): void {
    this.sqlLog.push(sql);

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
        owner_account_id: params[4] === null ? null : String(params[4]),
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
      this.writers.set(`${params[0]}/${params[1]}`, {
        branch_id: String(params[2]),
      });
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
      this.heapDeltas.set(
        `${params[0]}/${params[1]}/${params[2]}/${params[3]}`,
        {
          heap_delta_json: String(params[12]),
        },
      );
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
      this.nodeRefs.set(
        `${params[0]}/${params[1]}/${params[2]}/${params[3]}/${params[4]}`,
        {
          node_hash: String(params[6]),
          ref_json: String(params[12]),
        },
      );
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
      if (
        fact &&
        fact.root_drop_id === params[0] &&
        fact.branch_id === params[1]
      ) {
        this.priorityFacts.delete(String(params[2]));
      }
      return;
    }

    if (sql.includes("INSERT INTO nullmem_records")) {
      this.nullmemRecords.set(
        `${params[0]}/${params[1]}/${params[2]}/${params[3]}`,
        {
          root_drop_id: String(params[0]),
          branch_id: String(params[1]),
          record_kind: String(params[2]),
          record_json: String(params[12]),
          priority: Number(params[8] ?? 0),
          created_at: Number(params[10]),
        },
      );
      return;
    }

    if (sql.includes("DELETE FROM nullmem_records")) {
      [...this.nullmemRecords.keys()]
        .filter(
          (key) =>
            key === `${params[0]}/${params[1]}/fact/${params[2]}` ||
            key === `${params[0]}/${params[1]}/procedure/${params[2]}`,
        )
        .forEach((key) => this.nullmemRecords.delete(key));
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
      this.nodes.set(
        `${params[0]}/${params[1]}/${params[2]}/${params[3]}/${params[4]}`,
        {
          node_id: String(params[4]),
          node_json: String(params[10]),
          text: String(params[8]),
        },
      );
    }
  }

  first(sql: string, params: unknown[]): Record<string, unknown> | null {
    if (sql.includes("FROM accounts")) {
      return this.accounts.get(String(params[0])) ?? null;
    }

    if (sql.includes("FROM branches")) {
      return this.branches.get(`${params[0]}/${params[1]}`) ?? null;
    }

    if (sql.includes("FROM public_drops")) {
      return this.publicDrops.get(String(params[0])) ?? null;
    }

    if (sql.includes("FROM branch_snapshots")) {
      return (
        this.snapshots.get(`${params[0]}/${params[1]}/${params[2]}`) ?? null
      );
    }

    if (sql.includes("FROM branch_events") && sql.includes("seq = ?")) {
      return this.events.get(`${params[0]}/${params[1]}/${params[2]}`) ?? null;
    }

    if (sql.includes("FROM branch_events") && sql.includes("event_id = ?")) {
      return (
        [...this.events.entries()]
          .filter(([key]) => key.startsWith(`${params[0]}/${params[1]}/`))
          .map(([, event]) => event)
          .find((event) => event.event_id === params[2]) ?? null
      );
    }

    if (
      sql.includes("SELECT 1 AS found") &&
      sql.includes("FROM branch_events")
    ) {
      const found = [...this.events.values()].some(
        (event) =>
          event.event_id === params[2] &&
          this.events.has(`${params[0]}/${params[1]}/${event.seq}`),
      );
      return found ? { found: 1 } : null;
    }

    if (sql.includes("FROM resolved_heaps")) {
      return (
        this.heaps.get(`${params[0]}/${params[1]}/${params[2]}/${params[3]}`) ??
        null
      );
    }

    if (sql.includes("FROM resolved_heap_deltas")) {
      return (
        this.heapDeltas.get(
          `${params[0]}/${params[1]}/${params[2]}/${params[3]}`,
        ) ?? null
      );
    }

    if (sql.includes("FROM resolved_priority_facts")) {
      const fact = this.priorityFacts.get(String(params[2]));
      if (
        fact &&
        fact.root_drop_id === params[0] &&
        fact.branch_id === params[1]
      ) {
        return fact as unknown as Record<string, unknown>;
      }
      return null;
    }

    if (sql.includes("FROM resolved_node_payloads")) {
      return this.nodePayloads.get(String(params[0])) ?? null;
    }

    return null;
  }

  all(sql: string, params: unknown[]): Record<string, unknown>[] {
    if (sql.includes("FROM resolved_node_payloads")) {
      return [...this.nodePayloads.entries()]
        .filter(([hash]) => params.includes(hash))
        .map(([hash, row]) => ({ ...row, node_hash: hash }));
    }

    if (
      sql.includes("FROM drops") &&
      sql.includes("owner_account_id IS NOT NULL")
    ) {
      const afterId = sql.includes("id > ?") ? String(params[0]) : null;
      const limit = Number(params.at(-1));
      return [...this.drops.values()]
        .filter((drop) => drop.owner_account_id !== null)
        .filter((drop) => !afterId || drop.id > afterId)
        .sort((left, right) => left.id.localeCompare(right.id))
        .slice(0, limit)
        .map((drop) => ({ id: drop.id }));
    }

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
        .filter((row) =>
          excludeClient ? row.source_client_id !== excludeClient : true,
        )
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
        .filter(([key]) =>
          key.startsWith(
            `${params[0]}/${params[1]}/${params[2]}/${params[3]}/`,
          ),
        )
        .map(([, value]) => value);
    }

    if (sql.includes("FROM resolved_nodes")) {
      return [...this.nodes.entries()]
        .filter(([key]) =>
          key.startsWith(
            `${params[0]}/${params[1]}/${params[2]}/${params[3]}/`,
          ),
        )
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
          .filter(
            ({ fact }) =>
              fact.root_drop_id === params[0] && fact.branch_id === params[1],
          )
          .filter(({ fact }) => !resolverId || fact.resolver_id === resolverId)
          .filter(
            ({ parsed }) => !targetKind || parsed.targetKind === targetKind,
          )
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

    if (sql.includes("FROM nullmem_records")) {
      let bindingIndex = 2;
      const kind = sql.includes("record_kind = ?")
        ? String(params[bindingIndex++])
        : null;
      const limit = Number(params[bindingIndex]);
      return [...this.nullmemRecords.values()]
        .filter(
          (record) =>
            (record.root_drop_id === "" && record.branch_id === "") ||
            (record.root_drop_id === params[0] &&
              record.branch_id === params[1]),
        )
        .filter((record) => !kind || record.record_kind === kind)
        .sort((left, right) => {
          if (right.priority !== left.priority)
            return right.priority - left.priority;
          return right.created_at - left.created_at;
        })
        .slice(0, limit);
    }

    return [];
  }
}

export const createBranch = (
  overrides: Partial<DropBranchRecord> = {},
): DropBranchRecord => ({
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

export const createSnapshot = (
  overrides: Partial<DropSnapshotRecord> = {},
): DropSnapshotRecord => {
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

export const createEvent = (): DropDiffEvent => ({
  eventId: "evt_1",
  seq: 0,
  dropId: "drop_123456789",
  sourceClientId: "client_1",
  createdAt: 1001,
  snapshotId: 1,
  ops: [{ type: "insert", start: 0, end: 0, text: "Hello" }],
});

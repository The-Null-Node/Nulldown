import type { DropDiffEvent } from "../../../../../shared/drop/diff";

interface StoredObject {
  value: string;
  contentType: string;
  etag: string;
  uploaded: Date;
}

export class MemoryR2Bucket {
  private readonly objects = new Map<string, StoredObject>();
  private etagSequence = 0;
  readonly getCalls: string[] = [];
  readonly listCalls: string[] = [];

  clearReadMetrics(): void {
    this.getCalls.length = 0;
    this.listCalls.length = 0;
  }

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
    this.getCalls.push(key);
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
      string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream | null,
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
    this.listCalls.push(prefix);
    const limit = Math.max(1, Math.min(1000, options?.limit ?? 1000));
    const startAfter = options?.startAfter ?? "";
    const startIndex = options?.cursor
      ? Number.parseInt(options.cursor, 10)
      : 0;

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
    this.etagSequence += 1;
    return `memory-etag-${this.etagSequence}-${input.length}`;
  }

  private async toText(
    value:
      string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream | null,
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

interface RuntimeDataRecordRow {
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

export class MemoryD1Database {
  private readonly records = new Map<string, RuntimeDataRecordRow>();
  private readonly branchEvents = new Map<
    string,
    {
      rootDropId: string;
      branchId: string;
      seq: number;
      eventId: string;
      eventJson: string;
    }
  >();
  private readonly branchRuntimeFacts = new Map<
    string,
    {
      rootDropId: string;
      branchId: string;
      seq: number;
      factId: string;
      factJson: string;
    }
  >();
  readonly priorityFacts = new Map<string, string>();
  readonly nullmemRecords = new Map<string, string>();
  readonly batchCalls: number[] = [];
  runCalls = 0;
  readonly accountLibraryEntries = new Map<
    string,
    {
      entry_seq: number;
      drop_id: string;
      account_id: string;
      visibility: unknown;
      created_at: number;
      updated_at: number;
      deleted_at: number | null;
    }
  >();

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

  private branchEventKey(
    rootDropId: unknown,
    branchId: unknown,
    seq: unknown,
  ): string {
    return `${String(rootDropId)}/${String(branchId)}/${String(seq)}`;
  }

  readBranchEvent(
    rootDropId: string,
    branchId: string,
    seq: number,
  ): DropDiffEvent | null {
    const event = this.branchEvents.get(
      this.branchEventKey(rootDropId, branchId, seq),
    );
    return event ? (JSON.parse(event.eventJson) as DropDiffEvent) : null;
  }

  seedBranchEvent(
    rootDropId: string,
    branchId: string,
    event: DropDiffEvent,
  ): void {
    this.branchEvents.set(
      this.branchEventKey(rootDropId, branchId, event.seq),
      {
        rootDropId,
        branchId,
        seq: event.seq,
        eventId: event.eventId,
        eventJson: JSON.stringify(event),
      },
    );
  }

  run(sql: string, params: unknown[]): void {
    this.runCalls += 1;
    if (sql.includes("UPDATE branch_events")) {
      const key = this.branchEventKey(params[2], params[3], params[4]);
      const existing = this.branchEvents.get(key);
      if (existing) {
        this.branchEvents.set(key, {
          ...existing,
          eventJson: String(params[1]),
        });
      }
      return;
    }

    if (sql.includes("INSERT OR IGNORE INTO branch_events")) {
      const key = this.branchEventKey(params[0], params[1], params[2]);
      const duplicateEventId = [...this.branchEvents.values()].some(
        (event) =>
          event.rootDropId === params[0] &&
          event.branchId === params[1] &&
          event.eventId === params[3],
      );
      if (!this.branchEvents.has(key) && !duplicateEventId) {
        this.branchEvents.set(key, {
          rootDropId: String(params[0]),
          branchId: String(params[1]),
          seq: Number(params[2]),
          eventId: String(params[3]),
          eventJson: String(params[7]),
        });
      }
      return;
    }

    if (sql.includes("INSERT OR IGNORE INTO branch_runtime_facts")) {
      const key = this.branchEventKey(params[0], params[1], params[2]);
      if (!this.branchRuntimeFacts.has(key)) {
        this.branchRuntimeFacts.set(key, {
          rootDropId: String(params[0]),
          branchId: String(params[1]),
          seq: Number(params[2]),
          factId: String(params[3]),
          factJson: String(params[5]),
        });
      }
      return;
    }

    if (sql.includes("INSERT INTO void_data_records")) {
      this.records.set(
        this.recordKey(params[0], params[1], params[2], params[3]),
        {
          namespace: String(params[0]),
          collection: String(params[1]),
          scope_key: String(params[2]),
          id: String(params[3]),
          record_json: String(params[5]),
        },
      );
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
      this.records.delete(
        this.recordKey(params[0], params[1], params[2], params[3]),
      );
    }
  }

  first(sql: string, params: unknown[]): Record<string, unknown> | null {
    if (sql.includes("FROM account_library_entries")) {
      return this.accountLibraryEntries.get(String(params[0])) ?? null;
    }
    if (sql.includes("FROM branch_events")) {
      if (sql.includes("seq = ?")) {
        const event = this.branchEvents.get(
          this.branchEventKey(params[0], params[1], params[2]),
        );
        return event ? { event_json: event.eventJson } : null;
      }
      if (sql.includes("event_id = ?")) {
        const event = [...this.branchEvents.values()].find(
          (entry) =>
            entry.rootDropId === params[0] &&
            entry.branchId === params[1] &&
            entry.eventId === params[2],
        );
        return event ? { event_json: event.eventJson } : null;
      }
    }
    if (sql.includes("FROM branch_runtime_facts")) {
      const facts = [...this.branchRuntimeFacts.values()].filter(
        (fact) => fact.rootDropId === params[0] && fact.branchId === params[1],
      );
      if (sql.includes("fact_id = ?")) {
        const fact = facts.find((entry) => entry.factId === params[2]);
        return fact ? { fact_json: fact.factJson } : null;
      }
      if (sql.includes("MAX(seq)")) {
        return {
          max_seq: facts.length
            ? Math.max(...facts.map((fact) => fact.seq))
            : null,
        };
      }
    }
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
    if (sql.includes("FROM branch_events")) {
      return [...this.branchEvents.values()]
        .filter(
          (event) =>
            event.rootDropId === params[0] && event.branchId === params[1],
        )
        .sort((left, right) => left.seq - right.seq)
        .map((event) => ({ event_json: event.eventJson }));
    }
    if (sql.includes("FROM branch_runtime_facts")) {
      return [...this.branchRuntimeFacts.values()]
        .filter(
          (fact) =>
            fact.rootDropId === params[0] &&
            fact.branchId === params[1] &&
            fact.seq > Number(params[2]),
        )
        .sort((left, right) => left.seq - right.seq)
        .slice(0, Number(params[3]))
        .map((fact) => ({ fact_json: fact.factJson }));
    }
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

export const rootDropId = "AaBbCc112233";
export const accountId = "acct_1";

export const createPostRequest = (events: unknown): Request =>
  new Request(`https://nulldown.test/api/diff/${rootDropId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-nulldown-account-id": accountId,
    },
    body: JSON.stringify({ version: 1, events }),
  });

export const createPostRequestWithClientHeader = (
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

export const createPostRequestForBranch = (
  events: unknown,
  branchId: string,
  requestAccountId: string,
): Request =>
  new Request(
    `https://nulldown.test/api/diff/${rootDropId}?branchId=${encodeURIComponent(branchId)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-nulldown-account-id": requestAccountId,
      },
      body: JSON.stringify({ version: 1, events }),
    },
  );

export const createPostRequestWithPartialProviderHeaders = (
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

export const createGetRequest = (query = ""): Request =>
  new Request(`https://nulldown.test/api/diff/${rootDropId}${query}`, {
    method: "GET",
    headers: {
      "x-nulldown-account-id": accountId,
    },
  });

export const makeEvent = (input: {
  eventId: string;
  sourceClientId: string;
  text: string;
  createdAt: number;
  metadata?: DropDiffEvent["metadata"];
}): DropDiffEvent => ({
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

/** Creates an in-memory bucket with an account-owned root drop. */
export const createSeededBucket = (): MemoryR2Bucket => {
  const bucket = new MemoryR2Bucket();
  bucket.seed(
    rootDropId,
    JSON.stringify({
      content: "",
      metadata: { ownerAccountId: accountId },
    }),
    "application/json",
  );
  return bucket;
};

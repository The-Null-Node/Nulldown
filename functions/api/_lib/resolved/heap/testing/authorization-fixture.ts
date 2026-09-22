import { createBranchRepository } from "../../../branches/storage/repository";
import {
  createResolvedPriorityFact,
  deleteResolvedPriorityFact,
  listResolvedPriorityFacts,
} from "../priority-fact-service";
import { queryResolvedHeap } from "../query-service";
import {
  RESOLVED_DOCUMENT_RESOLVER_ID,
  RESOLVED_PRIORITY_FACT_RECORD_VERSION,
} from "../../../../../../shared/drop/resolved/constants";
import type { DropBranchRecord } from "../../../../../../shared/drop/branch";
import type { ResolvedPriorityFactRecord } from "../../../../../../shared/drop/resolved/types";
import type {
  BlobObjectBody,
  BlobObjectStore,
  BlobWriteCondition,
  SqlBindableValue,
  SqlMetadataStore,
  SqlStatement,
} from "../../../../../../src/server/ports";

interface ProjectionRow {
  entry_seq: number;
  drop_id: string;
  account_id: string;
  visibility: unknown;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export class InstrumentedBlobStore implements BlobObjectStore {
  private readonly objects = new Map<string, string>();
  private revision = 0;
  readonly reads = { aliases: 0, branches: 0, deeper: 0 };
  writes = 0;

  resetInstrumentation(): void {
    this.reads.aliases = 0;
    this.reads.branches = 0;
    this.reads.deeper = 0;
    this.writes = 0;
  }

  private countRead(key: string): void {
    if (key.startsWith("__drop_alias__/")) this.reads.aliases += 1;
    else if (key.startsWith("__drop_branch__/")) this.reads.branches += 1;
    else this.reads.deeper += 1;
  }

  async get(key: string) {
    this.countRead(key);
    const value = this.objects.get(key);
    if (value === undefined) return null;
    return {
      key,
      etag: `etag-${this.revision}`,
      httpEtag: `etag-${this.revision}`,
      text: async () => value,
      json: async <T>() => JSON.parse(value) as T,
    };
  }

  async head(key: string) {
    const value = this.objects.get(key);
    return value === undefined
      ? null
      : {
          key,
          etag: `etag-${this.revision}`,
          httpEtag: `etag-${this.revision}`,
        };
  }

  async put(
    key: string,
    value: BlobObjectBody,
    options?: { onlyIf?: BlobWriteCondition },
  ) {
    if (options?.onlyIf?.etagDoesNotMatch === "*" && this.objects.has(key)) {
      return null;
    }
    const text =
      typeof value === "string"
        ? value
        : await new Response(value as BodyInit | null).text();
    this.objects.set(key, text);
    this.writes += 1;
    this.revision += 1;
    return {
      key,
      etag: `etag-${this.revision}`,
      httpEtag: `etag-${this.revision}`,
    };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys])
      this.objects.delete(key);
  }

  async list(options?: { prefix?: string }) {
    const prefix = options?.prefix ?? "";
    this.countRead(prefix);
    return {
      objects: [...this.objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key })),
      truncated: false,
    };
  }
}

export class PriorityReadDatabase implements SqlMetadataStore {
  readonly reads = { projection: 0, priority: 0 };
  readonly writes = { aliases: 0, priority: 0 };
  runs = 0;
  readonly priorityFacts: ResolvedPriorityFactRecord[] = [];

  constructor(private readonly rows: Map<string, ProjectionRow>) {}

  resetInstrumentation(): void {
    this.reads.projection = 0;
    this.reads.priority = 0;
    this.writes.aliases = 0;
    this.writes.priority = 0;
    this.runs = 0;
  }

  prepare(sql: string): SqlStatement {
    let values: SqlBindableValue[] = [];
    const statement: SqlStatement = {
      bind: (...bound) => {
        values = bound;
        return statement;
      },
      run: async () => {
        this.runs += 1;
        if (sql.includes("INSERT INTO drop_aliases")) {
          this.writes.aliases += 1;
        }
        if (sql.includes("INSERT INTO resolved_priority_facts")) {
          this.writes.priority += 1;
          const fact = JSON.parse(
            String(values[10]),
          ) as ResolvedPriorityFactRecord;
          const existingIndex = this.priorityFacts.findIndex(
            (existing) =>
              existing.rootDropId === fact.rootDropId &&
              existing.branchId === fact.branchId &&
              existing.factId === fact.factId,
          );
          if (existingIndex >= 0) {
            this.priorityFacts.splice(existingIndex, 1, fact);
          } else {
            this.priorityFacts.push(fact);
          }
        }
        if (sql.includes("DELETE FROM resolved_priority_facts")) {
          this.writes.priority += 1;
          const existingIndex = this.priorityFacts.findIndex(
            (fact) =>
              fact.rootDropId === values[0] &&
              fact.branchId === values[1] &&
              fact.factId === values[2],
          );
          if (existingIndex >= 0) this.priorityFacts.splice(existingIndex, 1);
        }
        return { success: true };
      },
      first: async <T>() => {
        if (sql.includes("FROM account_library_entries")) {
          this.reads.projection += 1;
          return (this.rows.get(String(values[0])) as T | undefined) ?? null;
        }
        if (sql.includes("FROM resolved_priority_facts")) {
          this.reads.priority += 1;
          const fact = this.priorityFacts.find(
            (candidate) =>
              candidate.rootDropId === values[0] &&
              candidate.branchId === values[1] &&
              candidate.factId === values[2],
          );
          return fact ? ({ fact_json: JSON.stringify(fact) } as T) : null;
        }
        return null;
      },
      all: async <T>() => {
        if (!sql.includes("FROM resolved_priority_facts")) {
          return { results: [] as T[] };
        }

        this.reads.priority += 1;
        const rootDropId = String(values[0]);
        const branchId = String(values[1]);
        const resolverId = sql.includes("branch_id = ''")
          ? String(values[2])
          : undefined;
        const facts = this.priorityFacts
          .filter(
            (fact) =>
              fact.rootDropId === rootDropId && fact.branchId === branchId,
          )
          .filter(
            (fact) =>
              resolverId === undefined || fact.resolverId === resolverId,
          )
          .map((fact) => ({ fact_json: JSON.stringify(fact) }));
        return { results: facts as T[] };
      },
    };
    return statement;
  }
}

export const roots = {
  public: "PrioPublic01",
  unlisted: "PrioUnlist01",
  private: "PrioPrivate1",
  tombstone: "PrioDelete01",
  malformed: "PrioBadVis01",
  legacy: "PrioLegacy01",
  noDatabase: "PrioNoData01",
} as const;
export const canonicalOwner = "account-owner";
export const writer = "account-writer";
export const siblingWriter = "account-sibling";
export const forgedOwner = "account-forged";
export const unrelated = "account-unrelated";

const projection = (
  dropId: string,
  visibility: "public" | "unlisted" | "private",
  deletedAt: number | null = null,
): ProjectionRow => ({
  entry_seq: 1,
  drop_id: dropId,
  account_id: canonicalOwner,
  visibility,
  created_at: 1,
  updated_at: 1,
  deleted_at: deletedAt,
});

const branch = (rootDropId: string): DropBranchRecord => ({
  version: 1,
  rootDropId,
  branchId: "writer",
  baseDropId: rootDropId,
  mode: "clone",
  status: "active",
  ownerAccountId: forgedOwner,
  writerAccountId: writer,
  writerClientId: null,
  headSnapshotId: 0,
  headEventSeq: null,
  createdAt: 1,
  updatedAt: 1,
});

const documentContent = `# Priority title

## Priority heading

Priority target paragraph.

\`\`\`nd(id="RuntimeDrop01")
RuntimeDrop01
\`\`\`
`;

const seedBranch = async (
  bucket: InstrumentedBlobStore,
  record: DropBranchRecord,
): Promise<void> => {
  const repository = createBranchRepository({ blobs: bucket });
  await repository.writeBranch(record);
  await repository.writeSnapshot({
    version: 1,
    rootDropId: record.rootDropId,
    branchId: record.branchId,
    snapshotId: 0,
    parentSnapshotId: null,
    seq: 0,
    eventIds: [],
    checkpointed: true,
    textLength: documentContent.length,
    createdAt: 1,
  });
  await repository.writeSnapshotCheckpoint(
    record.rootDropId,
    record.branchId,
    0,
    documentContent,
  );
};

export const setup = async () => {
  const bucket = new InstrumentedBlobStore();
  const db = new PriorityReadDatabase(
    new Map<string, ProjectionRow>([
      [roots.public, projection(roots.public, "public")],
      [roots.unlisted, projection(roots.unlisted, "unlisted")],
      [roots.private, projection(roots.private, "private")],
      [roots.tombstone, projection(roots.tombstone, "public", 2)],
      [
        roots.malformed,
        { ...projection(roots.malformed, "public"), visibility: "invalid" },
      ],
    ]),
  );
  for (const rootDropId of Object.values(roots)) {
    await seedBranch(bucket, branch(rootDropId));
  }
  bucket.resetInstrumentation();
  db.resetInstrumentation();
  return { bucket, db };
};

const envFor = (bucket: InstrumentedBlobStore, db?: SqlMetadataStore) => ({
  R2_BUCKET: bucket,
  ...(db ? { DB: db } : {}),
  ALLOW_INSECURE_ACCOUNT_HEADER: "1",
  ACCOUNT_AUTH_SECRET: "test-secret",
});

const requestFor = (path: string, accountId?: string): Request => {
  const headers = new Headers();
  if (accountId) headers.set("x-nulldown-account-id", accountId);
  return new Request(`https://nulldown.test${path}`, { headers });
};

export const list = (
  bucket: InstrumentedBlobStore,
  db: SqlMetadataStore | undefined,
  rootDropId: string,
  accountId?: string,
  query = "",
) =>
  listResolvedPriorityFacts(
    envFor(bucket, db),
    { rootId: rootDropId, branchId: "writer" },
    requestFor(
      `/api/branches/${rootDropId}/writer/resolved/priority${query}`,
      accountId,
    ),
  );

interface PriorityRequestOptions {
  accountId?: string;
  authorization?: string;
  body?: string;
}

const priorityRequest = (
  path: string,
  method: "POST" | "DELETE",
  options: PriorityRequestOptions = {},
): Request => {
  const headers = new Headers();
  if (options.accountId) {
    headers.set("x-nulldown-account-id", options.accountId);
  }
  if (options.authorization) {
    headers.set("Authorization", options.authorization);
  }
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  return new Request(`https://nulldown.test${path}`, {
    method,
    headers,
    body: options.body,
  });
};

export const create = (
  bucket: InstrumentedBlobStore,
  db: SqlMetadataStore,
  rootDropId: string,
  options: PriorityRequestOptions = {},
) =>
  createResolvedPriorityFact(
    envFor(bucket, db),
    { rootId: rootDropId, branchId: "writer" },
    priorityRequest(
      `/api/branches/${rootDropId}/writer/resolved/priority`,
      "POST",
      options,
    ),
  );

export const deleteFact = (
  bucket: InstrumentedBlobStore,
  db: SqlMetadataStore,
  rootDropId: string,
  factId: string,
  options: PriorityRequestOptions = {},
) =>
  deleteResolvedPriorityFact(
    envFor(bucket, db),
    { rootId: rootDropId, branchId: "writer", factId },
    priorityRequest(
      `/api/branches/${rootDropId}/writer/resolved/priority/${encodeURIComponent(factId)}`,
      "DELETE",
      options,
    ),
  );

export const resolvedQuery = (
  bucket: InstrumentedBlobStore,
  db: SqlMetadataStore,
  rootDropId: string,
  accountId?: string,
  query = "",
) =>
  queryResolvedHeap(
    envFor(bucket, db),
    { rootId: rootDropId, branchId: "writer" },
    requestFor(
      `/api/branches/${rootDropId}/writer/resolved/query${query}`,
      accountId,
    ),
  );

export const priorityFact = (
  rootDropId: string,
  resolverId: string,
  targetId: string,
): ResolvedPriorityFactRecord => ({
  version: RESOLVED_PRIORITY_FACT_RECORD_VERSION,
  factId: `priority:${rootDropId}:${resolverId}`,
  rootDropId,
  branchId: "writer",
  resolverId,
  targetKind: "node",
  targetId,
  priority: 100,
  createdAt: 1,
});

export const priorityPayload = JSON.stringify({
  targetKind: "heap",
  priority: 100,
});

export const priorityFactForId = (
  rootDropId: string,
  factId: string,
): ResolvedPriorityFactRecord => ({
  ...priorityFact(rootDropId, RESOLVED_DOCUMENT_RESOLVER_ID, "node-target"),
  factId,
});

export interface QueryBody {
  nodes: Array<{ node: { id: string; text: string }; reasons: string[] }>;
}

export const queryBody = async (response: Response): Promise<QueryBody> =>
  response.json() as Promise<QueryBody>;

export const hasPriorityReason = (body: QueryBody): boolean =>
  body.nodes.some(({ reasons }) => reasons.includes("priority-fact"));

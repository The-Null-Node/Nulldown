import { createBranchRepository } from "../../../branches/storage/repository";
import { RESOLVED_DOCUMENT_RESOLVER_ID } from "../../../../../../shared/drop/resolved/constants";
import type { DropBranchRecord } from "../../../../../../shared/drop/branch";
import type {
  BlobObjectBody,
  BlobObjectStore,
  BlobWriteCondition,
  SqlBindableValue,
  SqlMetadataStore,
  SqlStatement,
} from "../../../../../../src/server/ports";
import { queryResolvedHeap } from "../query-service";
import { updateResolvedHeap } from "../update-service";

export type Visibility = "public" | "unlisted" | "private";

export interface ProjectionRow {
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

  reset(): void {
    this.reads.aliases = 0;
    this.reads.branches = 0;
    this.reads.deeper = 0;
    this.writes = 0;
  }

  private count(key: string): void {
    if (key.startsWith("__drop_alias__/")) this.reads.aliases += 1;
    else if (key.startsWith("__drop_branch__/")) this.reads.branches += 1;
    else this.reads.deeper += 1;
  }

  async get(key: string) {
    this.count(key);
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
    this.count(prefix);
    return {
      objects: [...this.objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key })),
      truncated: false,
    };
  }
}

export class ProjectionDatabase implements SqlMetadataStore {
  readonly deeperReads = { heaps: 0, priority: 0, runtimeFacts: 0 };
  runs = 0;

  constructor(private readonly rows: Map<string, ProjectionRow>) {}

  reset(): void {
    this.deeperReads.heaps = 0;
    this.deeperReads.priority = 0;
    this.deeperReads.runtimeFacts = 0;
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
        return { success: true };
      },
      first: async <T>() => {
        if (sql.includes("FROM account_library_entries")) {
          return (this.rows.get(String(values[0])) as T | undefined) ?? null;
        }
        if (sql.includes("FROM resolved_heap_states"))
          this.deeperReads.heaps += 1;
        return null;
      },
      all: async <T>() => {
        if (sql.includes("resolved_priority_facts"))
          this.deeperReads.priority += 1;
        if (sql.includes("nullplug_facts")) this.deeperReads.runtimeFacts += 1;
        return { results: [] as T[] };
      },
    };
    return statement;
  }
}

export const roots = {
  public: "ResolvedPublicRoot01",
  unlisted: "ResolvedUnlistRoot01",
  private: "ResolvedPrivateRoot01",
  tombstone: "ResolvedDeletedRoot01",
  malformed: "ResolvedMalformedRoot01",
  absent: "ResolvedAbsentRoot01",
  noDatabase: "ResolvedNoDbRoot01",
} as const;
export const owner = "account-owner";
export const writer = "account-writer";
export const siblingWriter = "account-sibling";
export const forgedOwner = "account-forged";
export const unrelated = "account-unrelated";

const projection = (
  dropId: string,
  visibility: Visibility,
  deletedAt: number | null = null,
): ProjectionRow => ({
  entry_seq: 1,
  drop_id: dropId,
  account_id: owner,
  visibility,
  created_at: 1,
  updated_at: 1,
  deleted_at: deletedAt,
});

const branch = (
  rootDropId: string,
  branchId: string,
  writerAccountId: string,
  ownerAccountId = owner,
): DropBranchRecord => ({
  version: 1,
  rootDropId,
  branchId,
  baseDropId: rootDropId,
  mode: "clone",
  status: "active",
  ownerAccountId,
  writerAccountId,
  writerClientId: null,
  headSnapshotId: 1,
  headEventSeq: null,
  createdAt: 1,
  updatedAt: 1,
});

const seedBranch = async (
  bucket: InstrumentedBlobStore,
  record: DropBranchRecord,
): Promise<void> => {
  const repository = createBranchRepository({ blobs: bucket });
  await repository.writeBranch(record);
  for (const snapshotId of [0, 1]) {
    await repository.writeSnapshot({
      version: 1,
      rootDropId: record.rootDropId,
      branchId: record.branchId,
      snapshotId,
      parentSnapshotId: snapshotId === 0 ? null : 0,
      seq: snapshotId,
      eventIds: [],
      checkpointed: true,
      textLength: 20,
      createdAt: snapshotId + 1,
    });
    await repository.writeSnapshotCheckpoint(
      record.rootDropId,
      record.branchId,
      snapshotId,
      `# Snapshot ${snapshotId}\n\nDocument content.`,
    );
  }
};

export const setup = async () => {
  const bucket = new InstrumentedBlobStore();
  const rows = new Map<string, ProjectionRow>([
    [roots.public, projection(roots.public, "public")],
    [roots.unlisted, projection(roots.unlisted, "unlisted")],
    [roots.private, projection(roots.private, "private")],
    [roots.tombstone, projection(roots.tombstone, "public", 2)],
    [
      roots.malformed,
      { ...projection(roots.malformed, "public"), visibility: "malformed" },
    ],
  ]);
  for (const rootDropId of Object.values(roots)) {
    await seedBranch(bucket, branch(rootDropId, "owner", owner));
  }
  await seedBranch(
    bucket,
    branch(roots.private, "writer", writer, forgedOwner),
  );
  await seedBranch(
    bucket,
    branch(roots.private, "sibling", siblingWriter, forgedOwner),
  );
  const db = new ProjectionDatabase(rows);
  bucket.reset();
  db.reset();
  return { bucket, db };
};

export const envFor = (
  bucket: InstrumentedBlobStore,
  db?: SqlMetadataStore,
) => ({
  R2_BUCKET: bucket,
  ...(db ? { DB: db } : {}),
  ALLOW_INSECURE_ACCOUNT_HEADER: "1",
  ACCOUNT_AUTH_SECRET: "test-secret",
});

export const requestFor = (
  rootDropId: string,
  branchId: string,
  query = "",
  accountId?: string,
  bearer?: string,
): Request => {
  const headers = new Headers();
  if (accountId) headers.set("x-nulldown-account-id", accountId);
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
  return new Request(
    `https://nulldown.test/api/branches/${rootDropId}/${branchId}/resolved/query${query}`,
    { headers },
  );
};

export const query = (
  bucket: InstrumentedBlobStore,
  db: SqlMetadataStore | undefined,
  rootDropId: string,
  branchId = "owner",
  queryString = "",
  accountId?: string,
  bearer?: string,
  options?: Parameters<typeof queryResolvedHeap>[3],
) =>
  queryResolvedHeap(
    envFor(bucket, db),
    { rootId: rootDropId, branchId },
    requestFor(rootDropId, branchId, queryString, accountId, bearer),
    options,
  );

export const update = (
  bucket: InstrumentedBlobStore,
  db: SqlMetadataStore | undefined,
  rootDropId: string,
  branchId = "owner",
  accountId?: string,
) => {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (accountId) headers.set("x-nulldown-account-id", accountId);
  return updateResolvedHeap(
    envFor(bucket, db),
    { rootId: rootDropId, branchId },
    new Request(
      `https://nulldown.test/api/branches/${rootDropId}/${branchId}/resolved/update`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ resolverId: RESOLVED_DOCUMENT_RESOLVER_ID }),
      },
    ),
  );
};

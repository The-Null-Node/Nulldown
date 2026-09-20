import { describe, expect, it, jest } from "@jest/globals";
import type { R2Bucket } from "@cloudflare/workers-types";
import { queryResolvedHeap } from "../functions/api/_lib/resolved/heap/queryService";
import { updateResolvedHeap } from "../functions/api/_lib/resolved/heap/updateService";
import { createBranchRepository } from "../functions/api/_lib/branches/storage/repository";
import { createRemoteAliasKey } from "../functions/api/_lib/drops/identity/id";
import { onRequestGet as queryResolvedRoute } from "../functions/api/branches/[rootId]/[branchId]/resolved/query";
import type { DropBranchRecord } from "../shared/drop/branch";
import {
  RESOLVED_DOCUMENT_RESOLVER_ID,
  RESOLVED_RUNTIME_REFS_RESOLVER_ID,
} from "../shared/drop/resolved/constants";
import type {
  VoidBlobBody,
  VoidBlobStore,
  VoidBlobWriteCondition,
  VoidSqlBindableValue,
  VoidSqlStatement,
  VoidSqlStore,
} from "./server/ports";

type Visibility = "public" | "unlisted" | "private";

interface ProjectionRow {
  entry_seq: number;
  drop_id: string;
  account_id: string;
  visibility: unknown;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

class InstrumentedBlobStore implements VoidBlobStore {
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
    value: VoidBlobBody,
    options?: { onlyIf?: VoidBlobWriteCondition },
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

class ProjectionDatabase implements VoidSqlStore {
  readonly deeperReads = { heaps: 0, priority: 0, runtimeFacts: 0 };
  runs = 0;

  constructor(private readonly rows: Map<string, ProjectionRow>) {}

  reset(): void {
    this.deeperReads.heaps = 0;
    this.deeperReads.priority = 0;
    this.deeperReads.runtimeFacts = 0;
    this.runs = 0;
  }

  prepare(sql: string): VoidSqlStatement {
    let values: VoidSqlBindableValue[] = [];
    const statement: VoidSqlStatement = {
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

const roots = {
  public: "ResolvedPublicRoot01",
  unlisted: "ResolvedUnlistRoot01",
  private: "ResolvedPrivateRoot01",
  tombstone: "ResolvedDeletedRoot01",
  malformed: "ResolvedMalformedRoot01",
  absent: "ResolvedAbsentRoot01",
  noDatabase: "ResolvedNoDbRoot01",
} as const;
const owner = "account-owner";
const writer = "account-writer";
const siblingWriter = "account-sibling";
const forgedOwner = "account-forged";
const unrelated = "account-unrelated";

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

const setup = async () => {
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

const envFor = (bucket: InstrumentedBlobStore, db?: VoidSqlStore) => ({
  R2_BUCKET: bucket,
  ...(db ? { DB: db } : {}),
  ALLOW_INSECURE_ACCOUNT_HEADER: "1",
  ACCOUNT_AUTH_SECRET: "test-secret",
});

const requestFor = (
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

const query = (
  bucket: InstrumentedBlobStore,
  db: VoidSqlStore | undefined,
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

const update = (
  bucket: InstrumentedBlobStore,
  db: VoidSqlStore | undefined,
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

const expectGenericBranchNotFound = async (
  response: Response,
): Promise<void> => {
  expect(response.status).toBe(404);
  await expect(response.json()).resolves.toEqual({
    error: "Branch not found.",
    code: "branch_not_found",
  });
};

const expectNoDeeperAccess = (
  bucket: InstrumentedBlobStore,
  db: ProjectionDatabase,
): void => {
  expect(bucket.reads.deeper).toBe(0);
  expect(bucket.writes).toBe(0);
  expect(db.deeperReads).toEqual({ heaps: 0, priority: 0, runtimeFacts: 0 });
};

describe("resolved heap GET authorization", () => {
  it.each([
    ["private", "RsPr01", roots.private, undefined],
    ["tombstoned", "RsDe01", roots.tombstone, owner],
    ["malformed", "RsBa01", roots.malformed, owner],
  ] as Array<[string, string, string, string | undefined]>)(
    "resolves an R2-only alias for a denied %s root without SQL writes or derived reads",
    async (_label, shortId, rootDropId, accountId) => {
      const { bucket, db } = await setup();
      await bucket.put(createRemoteAliasKey(shortId), rootDropId);
      bucket.reset();
      db.reset();

      const response = await query(bucket, db, shortId, "owner", "", accountId);

      await expectGenericBranchNotFound(response);
      expect(bucket.reads.aliases).toBe(1);
      expect(bucket.reads.branches).toBe(0);
      expect(db.runs).toBe(0);
      expectNoDeeperAccess(bucket, db);
    },
  );

  it("resolves an allowed R2-only short alias to its canonical root", async () => {
    const { bucket, db } = await setup();
    await bucket.put(createRemoteAliasKey("RsPu01"), roots.public);
    bucket.reset();
    db.reset();

    const response = await query(bucket, db, "RsPu01");
    expect(response.status).toBe(200);
  });

  it.each([
    ["private anonymous", roots.private, undefined, undefined, 0],
    ["private unrelated", roots.private, unrelated, undefined, 1],
    ["tombstoned", roots.tombstone, owner, undefined, 0],
    ["malformed projection", roots.malformed, owner, undefined, 0],
    ["invalid bearer", roots.private, owner, "invalid-token", 0],
  ] as Array<[string, string, string | undefined, string | undefined, number]>)(
    "hides a %s root before derived access",
    async (_label, rootDropId, accountId, bearer, expectedBranchReads) => {
      const { bucket, db } = await setup();
      const repair = jest.fn<() => void>();
      const dispatch = jest.fn<() => { items: unknown[] }>();
      const response = await query(
        bucket,
        db,
        rootDropId,
        "owner",
        "?snapshotterId=nulledit.unknown",
        accountId,
        bearer,
        { repairBufferedCommits: repair, querySnapshotter: dispatch },
      );

      await expectGenericBranchNotFound(response);
      expect(bucket.reads.branches).toBe(expectedBranchReads);
      expectNoDeeperAccess(bucket, db);
      expect(repair).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["sibling writer", writer, "sibling"],
    ["forged legacy owner", forgedOwner, "writer"],
  ] as Array<[string, string, string]>)(
    "hides the exact private branch from a %s before deeper reads",
    async (_label, accountId, branchId) => {
      const { bucket, db } = await setup();
      const response = await query(
        bucket,
        db,
        roots.private,
        branchId,
        "?snapshotId=0",
        accountId,
      );

      await expectGenericBranchNotFound(response);
      expect(bucket.reads.branches).toBe(1);
      expectNoDeeperAccess(bucket, db);
    },
  );

  it.each([
    ["public latest", roots.public, ""],
    ["unlisted explicit", roots.unlisted, "?snapshotId=0"],
    [
      "public canonical document snapshotter",
      roots.public,
      "?snapshotterId=nulledit.resolved-document",
    ],
    ["projection absent", roots.absent, "?snapshotId=0"],
  ] as Array<[string, string, string]>)(
    "preserves anonymous document reads for %s",
    async (_label, rootDropId, queryString) => {
      const { bucket, db } = await setup();
      const response = await query(
        bucket,
        db,
        rootDropId,
        "owner",
        queryString,
      );
      expect(response.status).toBe(200);
      expect(db.deeperReads.priority).toBe(0);
    },
  );

  it("preserves anonymous document reads when the projection database is absent", async () => {
    const { bucket } = await setup();
    const response = await query(bucket, undefined, roots.noDatabase);
    expect(response.status).toBe(200);
  });

  it.each([
    ["canonical owner", owner, "owner"],
    ["exact writer", writer, "writer"],
  ] as Array<[string, string, string]>)(
    "allows a private %s to read document snapshots",
    async (_label, accountId, branchId) => {
      const { bucket, db } = await setup();
      const response = await query(
        bucket,
        db,
        roots.private,
        branchId,
        "?snapshotId=0",
        accountId,
      );
      expect(response.status).toBe(200);
    },
  );

  it.each([
    ["runtime resolver", `?resolverId=${RESOLVED_RUNTIME_REFS_RESOLVER_ID}`],
    ["runtime snapshotter", "?snapshotterId=nulledit.resolved-runtime-refs"],
    ["unknown snapshotter", "?snapshotterId=nulledit.unknown"],
  ] as Array<[string, string]>)(
    "forbids anonymous public access to the %s before side effects",
    async (_label, queryString) => {
      const { bucket, db } = await setup();
      const repair = jest.fn<() => void>();
      const dispatch = jest.fn<() => { items: unknown[] }>();
      const response = await query(
        bucket,
        db,
        roots.public,
        "owner",
        queryString,
        undefined,
        undefined,
        { repairBufferedCommits: repair, querySnapshotter: dispatch },
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "Authenticated branch capability is required.",
        code: "forbidden",
      });
      expect(bucket.reads.branches).toBe(1);
      expectNoDeeperAccess(bucket, db);
      expect(repair).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it("forbids an unrelated account on an unlisted sensitive resolver", async () => {
    const { bucket, db } = await setup();
    const response = await query(
      bucket,
      db,
      roots.unlisted,
      "owner",
      `?resolverId=${RESOLVED_RUNTIME_REFS_RESOLVER_ID}&snapshotId=0`,
      unrelated,
    );
    expect(response.status).toBe(403);
    expectNoDeeperAccess(bucket, db);
  });

  it.each([
    ["projected canonical owner", roots.private, "sibling", owner, true],
    ["projected exact writer", roots.private, "writer", writer, true],
    ["legacy exact writer", roots.noDatabase, "owner", owner, false],
  ] as Array<[string, string, string, string, boolean]>)(
    "dispatches an authorized %s snapshotter query",
    async (_label, rootDropId, branchId, accountId, hasDatabase) => {
      const { bucket, db } = await setup();
      const dispatch = jest.fn((_id: string, request: { query?: string }) => ({
        items: [request.query],
      }));
      const response = await query(
        bucket,
        hasDatabase ? db : undefined,
        rootDropId,
        branchId,
        "?snapshotterId=nulledit.unknown&q=next&k=2",
        accountId,
        undefined,
        { querySnapshotter: dispatch },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ items: ["next"] });
      expect(dispatch).toHaveBeenCalledWith(
        "nulledit.unknown",
        expect.objectContaining({ query: "next", top: 2 }),
      );
    },
  );

  it("allows an exact writer to query an explicit runtime snapshot", async () => {
    const { bucket, db } = await setup();
    const response = await query(
      bucket,
      db,
      roots.private,
      "writer",
      `?resolverId=${RESOLVED_RUNTIME_REFS_RESOLVER_ID}&snapshotId=0`,
      writer,
    );
    expect(response.status).toBe(200);
  });

  it("keeps the Cloudflare special snapshotter route behind root authorization", async () => {
    const { bucket, db } = await setup();
    const response = await queryResolvedRoute({
      request: requestFor(
        roots.private,
        "owner",
        "?snapshotterId=nulledit.unknown",
      ),
      env: envFor(bucket, db) as unknown as { R2_BUCKET: R2Bucket },
      params: { rootId: roots.private, branchId: "owner" },
    } as never);

    await expectGenericBranchNotFound(response);
    expect(bucket.reads.branches).toBe(0);
    expectNoDeeperAccess(bucket, db);
  });
});

describe("resolved heap update authorization", () => {
  it("requires authentication before resolving an update alias", async () => {
    const { bucket, db } = await setup();
    await bucket.put(createRemoteAliasKey("RuAu01"), roots.public);
    bucket.reset();
    db.reset();
    const response = await update(bucket, db, "RuAu01");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Authenticated account session is required.",
      code: "account_required",
    });
    expect(bucket.reads).toEqual({ aliases: 0, branches: 0, deeper: 0 });
    expectNoDeeperAccess(bucket, db);
  });

  it.each([
    ["private unrelated", roots.private, "owner", unrelated, 404],
    ["tombstoned", roots.tombstone, "owner", owner, 404],
    ["malformed", roots.malformed, "owner", owner, 404],
    ["public unrelated", roots.public, "owner", unrelated, 403],
    ["unlisted unrelated", roots.unlisted, "owner", unrelated, 403],
  ] as Array<[string, string, string, string, number]>)(
    "rejects a %s update before projection writes",
    async (_label, rootDropId, branchId, accountId, expectedStatus) => {
      const { bucket, db } = await setup();
      const response = await update(
        bucket,
        db,
        rootDropId,
        branchId,
        accountId,
      );

      expect(response.status).toBe(expectedStatus);
      expectNoDeeperAccess(bucket, db);
    },
  );

  it.each([
    ["canonical owner", roots.private, "owner", owner],
    ["exact writer", roots.private, "writer", writer],
  ] as Array<[string, string, string, string]>)(
    "allows a private %s to rebuild its branch heap",
    async (_label, rootDropId, branchId, accountId) => {
      const { bucket, db } = await setup();
      const response = await update(
        bucket,
        db,
        rootDropId,
        branchId,
        accountId,
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({ rootDropId, branchId }),
      );
      expect(bucket.writes).toBeGreaterThan(0);
    },
  );
});

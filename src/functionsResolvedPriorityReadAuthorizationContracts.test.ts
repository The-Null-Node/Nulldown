import { describe, expect, it } from "@jest/globals";
import { createBranchRepository } from "../functions/api/_lib/branches/storage/repository";
import { createRemoteAliasKey } from "../functions/api/_lib/drops/identity/id";
import {
  createResolvedPriorityFact,
  deleteResolvedPriorityFact,
  listResolvedPriorityFacts,
} from "../functions/api/_lib/resolved/heap/priorityFactService";
import { queryResolvedHeap } from "../functions/api/_lib/resolved/heap/queryService";
import {
  RESOLVED_DOCUMENT_RESOLVER_ID,
  RESOLVED_PRIORITY_FACT_RECORD_VERSION,
  RESOLVED_RUNTIME_REFS_RESOLVER_ID,
} from "../shared/drop/resolved/constants";
import type { DropBranchRecord } from "../shared/drop/branch";
import type { ResolvedPriorityFactRecord } from "../shared/drop/resolved/types";
import type {
  BlobObjectBody,
  BlobObjectStore,
  BlobWriteCondition,
  SqlBindableValue,
  SqlStatement,
  SqlMetadataStore,
} from "./server/ports";

interface ProjectionRow {
  entry_seq: number;
  drop_id: string;
  account_id: string;
  visibility: unknown;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

class InstrumentedBlobStore implements BlobObjectStore {
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
      : { key, etag: `etag-${this.revision}`, httpEtag: `etag-${this.revision}` };
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
    return { key, etag: `etag-${this.revision}`, httpEtag: `etag-${this.revision}` };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
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

class PriorityReadDatabase implements SqlMetadataStore {
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

const roots = {
  public: "PrioPublic01",
  unlisted: "PrioUnlist01",
  private: "PrioPrivate1",
  tombstone: "PrioDelete01",
  malformed: "PrioBadVis01",
  legacy: "PrioLegacy01",
  noDatabase: "PrioNoData01",
} as const;
const canonicalOwner = "account-owner";
const writer = "account-writer";
const siblingWriter = "account-sibling";
const forgedOwner = "account-forged";
const unrelated = "account-unrelated";

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

const setup = async () => {
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

const list = (
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

const create = (
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

const deleteFact = (
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

const resolvedQuery = (
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

const priorityFact = (
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

const priorityPayload = JSON.stringify({
  targetKind: "heap",
  priority: 100,
});

const priorityFactForId = (
  rootDropId: string,
  factId: string,
): ResolvedPriorityFactRecord => ({
  ...priorityFact(rootDropId, RESOLVED_DOCUMENT_RESOLVER_ID, "node-target"),
  factId,
});

const expectBranchNotFound = async (response: Response): Promise<void> => {
  expect(response.status).toBe(404);
  await expect(response.json()).resolves.toEqual({
    error: "Branch not found.",
    code: "branch_not_found",
  });
};

const expectSensitiveForbidden = async (response: Response): Promise<void> => {
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toEqual({
    error: "Authenticated branch capability is required.",
    code: "forbidden",
  });
};

const expectMutationForbidden = async (
  response: Response,
  action: "create" | "delete",
): Promise<void> => {
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toEqual({
    error: `You are not allowed to ${action} priority facts for this branch.`,
    code: "forbidden",
  });
};

const expectAccountRequired = async (response: Response): Promise<void> => {
  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toEqual({
    error: "Authenticated account session is required.",
    code: "account_required",
  });
};

interface QueryBody {
  nodes: Array<{ node: { id: string; text: string }; reasons: string[] }>;
}

const queryBody = async (response: Response): Promise<QueryBody> =>
  response.json() as Promise<QueryBody>;

const hasPriorityReason = (body: QueryBody): boolean =>
  body.nodes.some(({ reasons }) => reasons.includes("priority-fact"));

describe("resolved priority fact read authorization", () => {
  it("authorizes priority fact creation only for trusted root authority or the exact writer", async () => {
    const { bucket, db } = await setup();

    for (const [rootDropId, accountId] of [
      [roots.public, canonicalOwner],
      [roots.public, writer],
      [roots.unlisted, canonicalOwner],
      [roots.unlisted, writer],
      [roots.private, canonicalOwner],
      [roots.private, writer],
    ] as const) {
      bucket.resetInstrumentation();
      db.resetInstrumentation();
      const response = await create(bucket, db, rootDropId, {
        accountId,
        body: priorityPayload,
      });
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({ rootDropId, branchId: "writer" }),
      );
      expect(db.writes.priority).toBe(1);
    }

    for (const accountId of [forgedOwner, siblingWriter, unrelated]) {
      bucket.resetInstrumentation();
      db.resetInstrumentation();
      await expectMutationForbidden(
        await create(bucket, db, roots.public, {
          accountId,
          body: "{}",
        }),
        "create",
      );
      expect(db.reads.priority).toBe(0);
      expect(db.writes.priority).toBe(0);
    }

    await expectAccountRequired(
      await create(bucket, db, roots.public, { body: "{}" }),
    );

    for (const accountId of [undefined, unrelated, siblingWriter]) {
      bucket.resetInstrumentation();
      db.resetInstrumentation();
      await expectBranchNotFound(
        await create(bucket, db, roots.private, {
          accountId,
          body: "{}",
        }),
      );
      expect(db.reads.priority).toBe(0);
      expect(db.writes.priority).toBe(0);
    }

    for (const [rootDropId, alias] of [
      [roots.tombstone, "PrCrt1"],
      [roots.malformed, "PrCrt2"],
    ] as const) {
      await bucket.put(createRemoteAliasKey(alias), rootDropId);
      bucket.resetInstrumentation();
      db.resetInstrumentation();
      await expectBranchNotFound(
        await create(bucket, db, alias, {
          accountId: canonicalOwner,
          body: "{}",
        }),
      );
      expect(bucket.reads).toEqual({ aliases: 1, branches: 0, deeper: 0 });
      expect(bucket.writes).toBe(0);
      expect(db.runs).toBe(0);
      expect(db.writes).toEqual({ aliases: 0, priority: 0 });
      expect(db.reads.priority).toBe(0);
    }

    bucket.resetInstrumentation();
    db.resetInstrumentation();
    const legacyWriter = await create(bucket, db, roots.legacy, {
      accountId: writer,
      body: priorityPayload,
    });
    expect(legacyWriter.status).toBe(201);
    expect(db.writes.priority).toBe(1);
    await expectMutationForbidden(
      await create(bucket, db, roots.legacy, {
        accountId: unrelated,
        body: "{}",
      }),
      "create",
    );

    bucket.resetInstrumentation();
    db.resetInstrumentation();
    const invalidBody = await create(bucket, db, roots.public, {
      accountId: canonicalOwner,
      body: "{}",
    });
    expect(invalidBody.status).toBe(400);
    await expect(invalidBody.json()).resolves.toEqual({
      error: "Priority fact payload must include targetKind and priority.",
      code: "validation_failed",
    });
    expect(db.writes.priority).toBe(0);

    bucket.resetInstrumentation();
    db.resetInstrumentation();
    await expectAccountRequired(
      await create(bucket, db, roots.public, {
        accountId: writer,
        authorization: "Bearer invalid",
        body: priorityPayload,
      }),
    );
    expect(db.writes.priority).toBe(0);
  });

  it("authorizes priority fact deletion only for trusted root authority or the exact writer", async () => {
    const { bucket, db } = await setup();

    for (const [rootDropId, accountId] of [
      [roots.public, canonicalOwner],
      [roots.public, writer],
      [roots.unlisted, canonicalOwner],
      [roots.unlisted, writer],
      [roots.private, canonicalOwner],
      [roots.private, writer],
    ] as const) {
      const factId = `priority:delete:${rootDropId}:${accountId}`;
      db.priorityFacts.push(priorityFactForId(rootDropId, factId));
      bucket.resetInstrumentation();
      db.resetInstrumentation();
      const response = await deleteFact(bucket, db, rootDropId, factId, {
        accountId,
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        rootDropId,
        branchId: "writer",
        factId,
        deleted: true,
      });
      expect(db.reads.priority).toBe(1);
      expect(db.writes.priority).toBe(1);
    }

    for (const accountId of [forgedOwner, siblingWriter, unrelated]) {
      bucket.resetInstrumentation();
      db.resetInstrumentation();
      await expectMutationForbidden(
        await deleteFact(bucket, db, roots.public, "priority:forbidden", {
          accountId,
        }),
        "delete",
      );
      expect(db.reads.priority).toBe(0);
      expect(db.writes.priority).toBe(0);
    }

    await expectAccountRequired(
      await deleteFact(bucket, db, roots.public, "priority:anonymous"),
    );

    for (const accountId of [undefined, unrelated, siblingWriter]) {
      bucket.resetInstrumentation();
      db.resetInstrumentation();
      await expectBranchNotFound(
        await deleteFact(bucket, db, roots.private, "", { accountId }),
      );
      expect(db.reads.priority).toBe(0);
      expect(db.writes.priority).toBe(0);
    }

    for (const [rootDropId, alias] of [
      [roots.tombstone, "PrDel1"],
      [roots.malformed, "PrDel2"],
    ] as const) {
      await bucket.put(createRemoteAliasKey(alias), rootDropId);
      bucket.resetInstrumentation();
      db.resetInstrumentation();
      await expectBranchNotFound(
        await deleteFact(bucket, db, alias, "", { accountId: canonicalOwner }),
      );
      expect(bucket.reads).toEqual({ aliases: 1, branches: 0, deeper: 0 });
      expect(bucket.writes).toBe(0);
      expect(db.runs).toBe(0);
      expect(db.writes).toEqual({ aliases: 0, priority: 0 });
      expect(db.reads.priority).toBe(0);
    }

    const legacyFactId = "priority:legacy:writer";
    db.priorityFacts.push(priorityFactForId(roots.legacy, legacyFactId));
    bucket.resetInstrumentation();
    db.resetInstrumentation();
    const legacyWriter = await deleteFact(bucket, db, roots.legacy, legacyFactId, {
      accountId: writer,
    });
    expect(legacyWriter.status).toBe(200);
    expect(db.writes.priority).toBe(1);
    await expectMutationForbidden(
      await deleteFact(bucket, db, roots.legacy, "priority:legacy:other", {
        accountId: unrelated,
      }),
      "delete",
    );

    bucket.resetInstrumentation();
    db.resetInstrumentation();
    const invalidFactId = await deleteFact(bucket, db, roots.public, "", {
      accountId: canonicalOwner,
    });
    expect(invalidFactId.status).toBe(400);
    await expect(invalidFactId.json()).resolves.toEqual({
      error: "factId is required.",
      code: "validation_failed",
    });
    expect(db.reads.priority).toBe(0);

    bucket.resetInstrumentation();
    db.resetInstrumentation();
    const missingFact = await deleteFact(
      bucket,
      db,
      roots.public,
      "priority:missing",
      { accountId: canonicalOwner },
    );
    expect(missingFact.status).toBe(404);
    await expect(missingFact.json()).resolves.toEqual({
      error: "Priority fact not found.",
      code: "priority_fact_not_found",
    });
    expect(db.reads.priority).toBe(1);
    expect(db.writes.priority).toBe(0);

    bucket.resetInstrumentation();
    db.resetInstrumentation();
    await expectAccountRequired(
      await deleteFact(bucket, db, roots.public, "priority:bearer", {
        accountId: writer,
        authorization: "Bearer invalid",
      }),
    );
    expect(db.reads.priority).toBe(0);
    expect(db.writes.priority).toBe(0);
  });

  it("requires sensitive authority before listing priority facts", async () => {
    const { bucket, db } = await setup();
    for (const rootDropId of [roots.public, roots.unlisted, roots.private, roots.legacy]) {
      db.priorityFacts.push(
        priorityFact(rootDropId, RESOLVED_DOCUMENT_RESOLVER_ID, "node-target"),
      );
    }

    for (const [rootDropId, accountId] of [
      [roots.public, canonicalOwner],
      [roots.public, writer],
      [roots.unlisted, canonicalOwner],
      [roots.unlisted, writer],
      [roots.private, canonicalOwner],
      [roots.private, writer],
      [roots.legacy, writer],
    ] as const) {
      db.resetInstrumentation();
      const response = await list(bucket, db, rootDropId, accountId);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({ facts: [expect.objectContaining({ rootDropId })] }),
      );
      expect(db.reads.priority).toBe(1);
    }

    db.resetInstrumentation();
    for (const accountId of [forgedOwner, siblingWriter, unrelated, undefined]) {
      await expectSensitiveForbidden(await list(bucket, db, roots.public, accountId));
    }
    expect(db.reads.priority).toBe(0);

    for (const accountId of [forgedOwner, siblingWriter, unrelated, undefined]) {
      db.resetInstrumentation();
      await expectBranchNotFound(await list(bucket, db, roots.private, accountId));
      expect(db.reads.priority).toBe(0);
    }
    for (const rootDropId of [roots.tombstone, roots.malformed]) {
      db.resetInstrumentation();
      bucket.resetInstrumentation();
      await expectBranchNotFound(await list(bucket, db, rootDropId, canonicalOwner));
      expect(bucket.reads.branches).toBe(0);
      expect(db.reads.priority).toBe(0);
    }

    const noDatabase = await list(bucket, undefined, roots.noDatabase, writer);
    expect(noDatabase.status).toBe(200);
    await expect(noDatabase.json()).resolves.toEqual({
      rootDropId: roots.noDatabase,
      branchId: "writer",
      facts: [],
    });

    await bucket.put(createRemoteAliasKey("PrDn01"), roots.private);
    bucket.resetInstrumentation();
    db.resetInstrumentation();
    await expectBranchNotFound(await list(bucket, db, "PrDn01"));
    expect(bucket.reads).toEqual({ aliases: 1, branches: 0, deeper: 0 });
    expect(bucket.writes).toBe(0);
    expect(db.runs).toBe(0);
    expect(db.reads.priority).toBe(0);

    bucket.resetInstrumentation();
    db.resetInstrumentation();
    const badFilter = await list(
      bucket,
      db,
      roots.public,
      canonicalOwner,
      "?targetKind=invalid",
    );
    expect(badFilter.status).toBe(400);
    await expect(badFilter.json()).resolves.toEqual({
      error: "Invalid targetKind.",
      code: "validation_failed",
    });
    expect(bucket.reads.branches).toBe(1);
    expect(db.reads.priority).toBe(0);
  });

  it("omits priority overlays from ordinary public and unlisted document reads", async () => {
    const { bucket, db } = await setup();
    const baselines = new Map<string, QueryBody>();
    for (const rootDropId of [roots.public, roots.unlisted]) {
      const baselineResponse = await resolvedQuery(bucket, db, rootDropId);
      expect(baselineResponse.status).toBe(200);
      const baseline = await queryBody(baselineResponse);
      const target = baseline.nodes.find(({ node }) =>
        node.text.includes("Priority target"),
      );
      if (!target) throw new Error("Expected a priority target node.");
      baselines.set(rootDropId, baseline);
      db.priorityFacts.push(
        priorityFact(rootDropId, RESOLVED_DOCUMENT_RESOLVER_ID, target.node.id),
      );
    }

    for (const rootDropId of [roots.public, roots.unlisted]) {
      for (const accountId of [undefined, unrelated]) {
        db.resetInstrumentation();
        const response = await resolvedQuery(bucket, db, rootDropId, accountId);
        expect(response.status).toBe(200);
        const body = await queryBody(response);
        expect(hasPriorityReason(body)).toBe(false);
        expect(body.nodes.map(({ node }) => node.id)).toEqual(
          baselines.get(rootDropId)?.nodes.map(({ node }) => node.id),
        );
        expect(db.reads.priority).toBe(0);
      }
    }

    db.resetInstrumentation();
    const forged = await resolvedQuery(bucket, db, roots.public, forgedOwner);
    expect(forged.status).toBe(200);
    expect(hasPriorityReason(await queryBody(forged))).toBe(false);
    expect(db.reads.priority).toBe(0);
  });

  it("retains priority scoring for the canonical owner and exact writer", async () => {
    const { bucket, db } = await setup();
    const targets = new Map<string, string>();
    for (const [rootDropId, accountId] of [
      [roots.public, canonicalOwner],
      [roots.private, canonicalOwner],
    ] as const) {
      const response = await resolvedQuery(bucket, db, rootDropId, accountId);
      expect(response.status).toBe(200);
      const target = (await queryBody(response)).nodes.find(({ node }) =>
        node.text.includes("Priority target"),
      );
      if (!target) throw new Error("Expected a priority target node.");
      targets.set(rootDropId, target.node.id);
      db.priorityFacts.push(
        priorityFact(rootDropId, RESOLVED_DOCUMENT_RESOLVER_ID, target.node.id),
      );
    }

    for (const [rootDropId, accountId] of [
      [roots.public, canonicalOwner],
      [roots.public, writer],
      [roots.private, canonicalOwner],
      [roots.private, writer],
    ] as const) {
      db.resetInstrumentation();
      const response = await resolvedQuery(bucket, db, rootDropId, accountId);
      expect(response.status).toBe(200);
      const body = await queryBody(response);
      expect(body.nodes[0]).toEqual(
        expect.objectContaining({
          node: expect.objectContaining({ id: targets.get(rootDropId) }),
          reasons: expect.arrayContaining(["priority-fact"]),
        }),
      );
      expect(db.reads.priority).toBe(1);
    }

    bucket.resetInstrumentation();
    db.resetInstrumentation();
    await expectBranchNotFound(await resolvedQuery(bucket, db, roots.private));
    expect(bucket.reads.branches).toBe(0);
    expect(bucket.reads.deeper).toBe(0);
    expect(db.reads.priority).toBe(0);
  });

  it("preserves runtime sensitive denial before priority reads and scoring for authority", async () => {
    const { bucket, db } = await setup();
    const runtimeQuery = `?resolverId=${RESOLVED_RUNTIME_REFS_RESOLVER_ID}`;
    const baselineResponse = await resolvedQuery(
      bucket,
      db,
      roots.public,
      canonicalOwner,
      runtimeQuery,
    );
    expect(baselineResponse.status).toBe(200);
    const runtimeTarget = (await queryBody(baselineResponse)).nodes[0];
    if (!runtimeTarget) throw new Error("Expected a runtime priority target node.");
    db.priorityFacts.push(
      priorityFact(
        roots.public,
        RESOLVED_RUNTIME_REFS_RESOLVER_ID,
        runtimeTarget.node.id,
      ),
    );

    bucket.resetInstrumentation();
    db.resetInstrumentation();
    await expectSensitiveForbidden(
      await resolvedQuery(bucket, db, roots.public, undefined, runtimeQuery),
    );
    expect(bucket.reads.branches).toBe(1);
    expect(bucket.reads.deeper).toBe(0);
    expect(db.reads.priority).toBe(0);

    for (const accountId of [canonicalOwner, writer]) {
      db.resetInstrumentation();
      const response = await resolvedQuery(
        bucket,
        db,
        roots.public,
        accountId,
        runtimeQuery,
      );
      expect(response.status).toBe(200);
      const body = await queryBody(response);
      expect(body.nodes[0]).toEqual(
        expect.objectContaining({
          node: expect.objectContaining({ id: runtimeTarget.node.id }),
          reasons: expect.arrayContaining(["priority-fact"]),
        }),
      );
      expect(db.reads.priority).toBe(1);
    }
  });
});

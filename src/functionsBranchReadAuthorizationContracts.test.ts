import { describe, expect, it } from "@jest/globals";
import type { PagesFunction } from "@cloudflare/workers-types";
import { onRequestGet as listBranches } from "../functions/api/branches/[id]";
import { onRequestGet as getContent } from "../functions/api/branches/[rootId]/[branchId]/content";
import { onRequestGet as listSnapshots } from "../functions/api/branches/[rootId]/[branchId]/snapshots";
import { onRequestPost as resolveBranch } from "../functions/api/branches/resolve/[id]";
import { createBranchRepository } from "../functions/api/_lib/branches/storage/repository";
import { canReadSensitiveBranch } from "../functions/api/_lib/security/readAuthorization";
import { createRemoteAliasKey } from "../functions/api/_lib/drops/identity/id";
import {
  createBranchKey,
  createCloneBranchId,
  createWriterBranchKey,
  createWriterKey,
} from "../functions/api/_lib/branches/storage/keys";
import type {
  VoidBlobBody,
  VoidBlobStore,
  VoidBlobWriteCondition,
  VoidSqlBindableValue,
  VoidSqlStatement,
  VoidSqlStore,
} from "./server/ports";
import type { DropBranchRecord } from "../shared/drop/branch";

interface StoredObject {
  value: string;
  contentType: string;
  etag: string;
}

class MemoryBlobStore implements VoidBlobStore {
  private readonly objects = new Map<string, StoredObject>();
  private revision = 0;
  aliasReads = 0;
  readonly reads = {
    branches: 0,
    branchLists: 0,
    snapshots: 0,
    checkpoints: 0,
    diffs: 0,
  };
  readonly writes = {
    branches: 0,
    snapshots: 0,
    checkpoints: 0,
    diffs: 0,
    writerPointers: 0,
  };

  resetReads(): void {
    this.aliasReads = 0;
    this.reads.branches = 0;
    this.reads.branchLists = 0;
    this.reads.snapshots = 0;
    this.reads.checkpoints = 0;
    this.reads.diffs = 0;
  }

  resetWrites(): void {
    this.writes.branches = 0;
    this.writes.snapshots = 0;
    this.writes.checkpoints = 0;
    this.writes.diffs = 0;
    this.writes.writerPointers = 0;
  }

  private countRead(key: string, list = false): void {
    if (key.startsWith("__drop_alias__/")) this.aliasReads += 1;
    else if (key.startsWith("__drop_branch__/")) {
      if (list) this.reads.branchLists += 1;
      else this.reads.branches += 1;
    } else if (key.startsWith("__drop_snapshot__/")) this.reads.snapshots += 1;
    else if (key.startsWith("__drop_checkpoint__/"))
      this.reads.checkpoints += 1;
    else if (key.startsWith("__drop_branch_diff")) this.reads.diffs += 1;
  }

  private countWrite(key: string): void {
    if (key.startsWith("__drop_branch__/")) this.writes.branches += 1;
    else if (key.startsWith("__drop_snapshot__/")) this.writes.snapshots += 1;
    else if (key.startsWith("__drop_checkpoint__/"))
      this.writes.checkpoints += 1;
    else if (key.startsWith("__drop_branch_diff")) this.writes.diffs += 1;
    else if (key.startsWith("__drop_writer_branch__/")) {
      this.writes.writerPointers += 1;
    }
  }

  async get(key: string) {
    this.countRead(key);
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      key,
      etag: object.etag,
      httpEtag: object.etag,
      httpMetadata: { contentType: object.contentType },
      text: async () => object.value,
      json: async <T>() => JSON.parse(object.value) as T,
    };
  }

  async head(key: string) {
    const object = this.objects.get(key);
    return object
      ? {
          key,
          etag: object.etag,
          httpEtag: object.etag,
          httpMetadata: { contentType: object.contentType },
        }
      : null;
  }

  async put(
    key: string,
    value: VoidBlobBody,
    options?: {
      httpMetadata?: { contentType?: string };
      onlyIf?: VoidBlobWriteCondition;
    },
  ) {
    this.countWrite(key);
    const existing = this.objects.get(key);
    if (options?.onlyIf?.etagDoesNotMatch === "*" && existing) return null;
    if (
      options?.onlyIf?.etagMatches &&
      existing?.etag !== options.onlyIf.etagMatches
    ) {
      return null;
    }
    const text =
      typeof value === "string"
        ? value
        : await new Response(value as BodyInit | null).text();
    const object = {
      value: text,
      contentType: options?.httpMetadata?.contentType ?? "application/json",
      etag: `etag-${this.revision++}`,
    };
    this.objects.set(key, object);
    return { key, etag: object.etag, httpEtag: object.etag };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys])
      this.objects.delete(key);
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  async list(options?: { prefix?: string }) {
    const prefix = options?.prefix ?? "";
    this.countRead(prefix, true);
    return {
      objects: [...this.objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key })),
      truncated: false,
    };
  }
}

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

class ProjectionDatabase implements VoidSqlStore {
  runs = 0;

  constructor(private readonly rows: Map<string, ProjectionRow>) {}

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
        return null;
      },
      all: async <T>() => ({ results: [] as T[] }),
    };
    return statement;
  }
}

const roots = {
  public: "PublicRoot01",
  unlisted: "UnlistRoot01",
  private: "PrivateRoot01",
  deletedPublic: "DelPublRoot1",
  deletedUnlisted: "DelUnliRoot1",
  deletedPrivate: "DelPrivRoot1",
  malformed: "Malformed001",
  missing: "MissingProj01",
  noDatabase: "NoDatabase01",
} as const;
const canonicalOwner = "account-owner";
const writer = "account-writer";
const unrelated = "account-unrelated";
const siblingWriter = "account-sibling-writer";
const forgedOwner = "account-forged-owner";

const projection = (
  dropId: string,
  visibility: Visibility,
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

const branch = (
  rootDropId: string,
  branchId: string,
  writerAccountId: string | null,
  ownerAccountId: string | null = canonicalOwner,
): DropBranchRecord => ({
  version: 1,
  rootDropId,
  branchId,
  baseDropId: rootDropId,
  mode: branchId === "owner" ? "owner" : "clone",
  status: "active",
  ownerAccountId,
  writerAccountId,
  writerClientId: null,
  headSnapshotId: 0,
  createdAt: branchId === "owner" ? 1 : branchId === "writer" ? 2 : 3,
  updatedAt: 3,
});

const seedBranch = async (
  bucket: MemoryBlobStore,
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
    textLength: record.branchId.length,
    createdAt: record.createdAt,
  });
  await repository.writeSnapshotCheckpoint(
    record.rootDropId,
    record.branchId,
    0,
    `content:${record.branchId}`,
  );
};

const setup = async () => {
  const bucket = new MemoryBlobStore();
  const rows = new Map<string, ProjectionRow>([
    [roots.public, projection(roots.public, "public")],
    [roots.unlisted, projection(roots.unlisted, "unlisted")],
    [roots.private, projection(roots.private, "private")],
    [roots.deletedPublic, projection(roots.deletedPublic, "public", 2)],
    [roots.deletedUnlisted, projection(roots.deletedUnlisted, "unlisted", 2)],
    [roots.deletedPrivate, projection(roots.deletedPrivate, "private", 2)],
    [
      roots.malformed,
      { ...projection(roots.malformed, "public"), visibility: "unknown" },
    ],
  ]);
  for (const rootDropId of Object.values(roots)) {
    await bucket.put(
      rootDropId,
      JSON.stringify({
        content: `root:${rootDropId}`,
        metadata: { ownerAccountId: canonicalOwner },
      }),
    );
    await seedBranch(bucket, branch(rootDropId, "owner", canonicalOwner));
  }
  await seedBranch(
    bucket,
    branch(roots.private, "writer", writer, forgedOwner),
  );
  await seedBranch(
    bucket,
    branch(roots.private, "sibling", siblingWriter, forgedOwner),
  );
  return { bucket, db: new ProjectionDatabase(rows) };
};

type Route = PagesFunction<any, any>;

const call = (
  route: Route,
  env: Record<string, unknown>,
  params: Record<string, string>,
  accountId?: string,
  bearer?: string,
): Promise<Response> => {
  const headers = new Headers();
  if (accountId) headers.set("x-nulldown-account-id", accountId);
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
  return Promise.resolve(
    route({
      request: new Request("https://nulldown.test/api/branches/read", {
        headers,
      }),
      env,
      params,
      data: {},
      functionPath: "",
      waitUntil: () => {},
      next: async () => new Response(null, { status: 404 }),
    } as never),
  );
};

const envFor = (
  bucket: MemoryBlobStore,
  db?: VoidSqlStore,
): Record<string, unknown> => ({
  R2_BUCKET: bucket,
  ...(db ? { DB: db } : {}),
  ALLOW_INSECURE_ACCOUNT_HEADER: "1",
  ACCOUNT_AUTH_SECRET: "test-secret",
});

const callAllReads = async (
  env: Record<string, unknown>,
  rootDropId: string,
  branchId = "owner",
  accountId?: string,
  bearer?: string,
): Promise<Response[]> =>
  Promise.all([
    call(listBranches, env, { id: rootDropId }, accountId, bearer),
    call(getContent, env, { rootId: rootDropId, branchId }, accountId, bearer),
    call(
      listSnapshots,
      env,
      { rootId: rootDropId, branchId },
      accountId,
      bearer,
    ),
  ]);

const callTargetReads = async (
  env: Record<string, unknown>,
  rootDropId: string,
  branchId = "owner",
  accountId?: string,
): Promise<Response[]> =>
  Promise.all([
    call(getContent, env, { rootId: rootDropId, branchId }, accountId),
    call(listSnapshots, env, { rootId: rootDropId, branchId }, accountId),
  ]);

const expectNoBranchDataReads = (bucket: MemoryBlobStore): void => {
  expect(bucket.reads).toEqual({
    branches: 0,
    branchLists: 0,
    snapshots: 0,
    checkpoints: 0,
    diffs: 0,
  });
};

const expectNoBranchDataWrites = (bucket: MemoryBlobStore): void => {
  expect(bucket.writes).toEqual({
    branches: 0,
    snapshots: 0,
    checkpoints: 0,
    diffs: 0,
    writerPointers: 0,
  });
};

const expectNoContentDataReads = (bucket: MemoryBlobStore): void => {
  expect(bucket.reads.snapshots).toBe(0);
  expect(bucket.reads.checkpoints).toBe(0);
  expect(bucket.reads.diffs).toBe(0);
};

const sensitiveReadRequest = (accountId?: string, bearer?: string): Request => {
  const headers = new Headers();
  if (accountId) headers.set("x-nulldown-account-id", accountId);
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
  return new Request("https://nulldown.test/api/sensitive-read", { headers });
};

const canReadSensitive = (
  db: VoidSqlStore | undefined,
  rootDropId: string,
  writerAccountId: string | null,
  accountId?: string,
  bearer?: string,
): Promise<boolean> =>
  canReadSensitiveBranch(
    sensitiveReadRequest(accountId, bearer),
    {
      ...(db ? { DB: db } : {}),
      ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      ACCOUNT_AUTH_SECRET: "test-secret",
    },
    rootDropId,
    { writerAccountId },
  );

describe("sensitive branch read authorization", () => {
  it("requires an authenticated account even for an exact writer", async () => {
    const { db } = await setup();
    await expect(canReadSensitive(db, roots.public, writer)).resolves.toBe(
      false,
    );
  });

  it.each([roots.public, roots.unlisted, roots.private])(
    "allows the exact writer on a live projected root %s",
    async (rootDropId) => {
      const { db } = await setup();
      await expect(
        canReadSensitive(db, rootDropId, writer, writer),
      ).resolves.toBe(true);
    },
  );

  it.each([roots.public, roots.unlisted, roots.private])(
    "allows the canonical owner on a live projected root %s",
    async (rootDropId) => {
      const { db } = await setup();
      await expect(
        canReadSensitive(db, rootDropId, writer, canonicalOwner),
      ).resolves.toBe(true);
    },
  );

  it.each([roots.deletedPublic, roots.deletedUnlisted, roots.deletedPrivate])(
    "denies every identity for tombstoned root %s",
    async (rootDropId) => {
      const { db } = await setup();
      await expect(
        canReadSensitive(db, rootDropId, writer, writer),
      ).resolves.toBe(false);
      await expect(
        canReadSensitive(db, rootDropId, writer, canonicalOwner),
      ).resolves.toBe(false);
    },
  );

  it("denies every identity for malformed projected visibility", async () => {
    const { db } = await setup();
    await expect(
      canReadSensitive(db, roots.malformed, writer, writer),
    ).resolves.toBe(false);
    await expect(
      canReadSensitive(db, roots.malformed, writer, canonicalOwner),
    ).resolves.toBe(false);
  });

  it.each(["missing projection", "missing database"] as const)(
    "preserves only exact-writer authority for a legacy root with %s",
    async (kind) => {
      const { db } = await setup();
      const projectionDb = kind === "missing projection" ? db : undefined;
      const rootDropId =
        kind === "missing projection" ? roots.missing : roots.noDatabase;
      await expect(
        canReadSensitive(projectionDb, rootDropId, writer, writer),
      ).resolves.toBe(true);
      await expect(
        canReadSensitive(projectionDb, rootDropId, writer, canonicalOwner),
      ).resolves.toBe(false);
    },
  );

  it("does not grant an exact writer access to a sibling branch", async () => {
    const { db } = await setup();
    await expect(
      canReadSensitive(db, roots.private, siblingWriter, writer),
    ).resolves.toBe(false);
  });

  it("does not fall back to the dev account header for an invalid bearer", async () => {
    const { db } = await setup();
    await expect(
      canReadSensitive(
        db,
        roots.private,
        canonicalOwner,
        canonicalOwner,
        "invalid-token",
      ),
    ).resolves.toBe(false);
  });

  it("accepts only the branch writer field on its branch type surface", () => {
    type SensitiveBranch = Parameters<typeof canReadSensitiveBranch>[3];
    const accepted: SensitiveBranch = { writerAccountId: writer };
    const forged: SensitiveBranch = {
      writerAccountId: writer,
      // @ts-expect-error Canonical ownership cannot enter through branch metadata.
      ownerAccountId: forgedOwner,
    };

    expect(accepted).toEqual({ writerAccountId: writer });
    expect(forged).toBeDefined();
  });
});

describe("private-root branch read authorization", () => {
  it.each([
    ["private", "BrPr01", roots.private],
    ["tombstoned", "BrDe01", roots.deletedPublic],
    ["malformed", "BrBa01", roots.malformed],
  ] as Array<[string, string, string]>)(
    "resolves an R2-only alias for a denied %s root without SQL writes or branch reads",
    async (_label, shortId, rootDropId) => {
      const { bucket, db } = await setup();
      await bucket.put(createRemoteAliasKey(shortId), rootDropId);
      bucket.resetReads();

      const responses = await callAllReads(
        envFor(bucket, db),
        shortId,
        "owner",
        rootDropId === roots.private ? undefined : canonicalOwner,
      );

      expect(responses.map(({ status }) => status)).toEqual([404, 404, 404]);
      expect(db.runs).toBe(0);
      expectNoBranchDataReads(bucket);
    },
  );

  it("resolves an allowed R2-only short alias to its canonical root", async () => {
    const { bucket, db } = await setup();
    await bucket.put(createRemoteAliasKey("BrPu01"), roots.public);
    bucket.resetReads();

    const responses = await callAllReads(envFor(bucket, db), "BrPu01");
    expect(responses.map(({ status }) => status)).toEqual([200, 200, 200]);
    await expect(responses[0].json()).resolves.toMatchObject({
      rootDropId: roots.public,
    });
    expect(db.runs).toBe(0);
  });

  it.each(["public", "unlisted"] as const)(
    "keeps projected %s branch reads anonymously identifier-readable",
    async (visibility) => {
      const { bucket, db } = await setup();
      const responses = await callAllReads(
        envFor(bucket, db),
        roots[visibility],
      );
      expect(responses.map(({ status }) => status)).toEqual([200, 200, 200]);
      await expect(responses[1].json()).resolves.toEqual(
        expect.objectContaining({ content: "content:owner" }),
      );
      await expect(responses[2].json()).resolves.toEqual(
        expect.objectContaining({
          snapshots: [expect.objectContaining({ snapshotId: 0 })],
        }),
      );
    },
  );

  it.each([
    ["anonymous", undefined, 0],
    ["unrelated account", unrelated, 2],
  ] as Array<[string, string | undefined, number]>)(
    "hides private branches from %s with indistinguishable 404s",
    async (_label, accountId, expectedBranchReads) => {
      const { bucket, db } = await setup();
      const responses = await callAllReads(
        envFor(bucket, db),
        roots.private,
        "owner",
        accountId,
      );
      expect(responses.map(({ status }) => status)).toEqual([404, 404, 404]);
      await Promise.all(
        responses.map(async (response) =>
          expect(await response.text()).toBe("Branch not found."),
        ),
      );

      bucket.resetReads();
      const targetResponses = await callTargetReads(
        envFor(bucket, db),
        roots.private,
        "owner",
        accountId,
      );
      expect(targetResponses.map(({ status }) => status)).toEqual([404, 404]);
      expect(bucket.reads.branches).toBe(expectedBranchReads);
      expect(bucket.reads.branchLists).toBe(0);
      expectNoContentDataReads(bucket);
    },
  );

  it("allows the canonical projected owner to list and read every private branch", async () => {
    const { bucket, db } = await setup();
    const env = envFor(bucket, db);
    const responses = await callAllReads(
      env,
      roots.private,
      "sibling",
      canonicalOwner,
    );
    expect(responses.map(({ status }) => status)).toEqual([200, 200, 200]);
    const listed = (await responses[0].json()) as {
      branches: DropBranchRecord[];
    };
    expect(listed.branches.map(({ branchId }) => branchId)).toEqual([
      "owner",
      "writer",
      "sibling",
    ]);
  });

  it("allows an explicit writer target and filters private branch lists to that writer", async () => {
    const { bucket, db } = await setup();
    const responses = await callAllReads(
      envFor(bucket, db),
      roots.private,
      "writer",
      writer,
    );
    expect(responses.map(({ status }) => status)).toEqual([200, 200, 200]);
    const listed = (await responses[0].json()) as {
      branches: DropBranchRecord[];
    };
    expect(listed.branches.map(({ branchId }) => branchId)).toEqual(["writer"]);
    expect(JSON.stringify(listed)).not.toContain("sibling");
  });

  it("never treats a forged branch owner as stronger than projected ownership", async () => {
    const { bucket, db } = await setup();
    const responses = await callAllReads(
      envFor(bucket, db),
      roots.private,
      "sibling",
      forgedOwner,
    );
    expect(responses.map(({ status }) => status)).toEqual([404, 404, 404]);
  });

  it("reads only the requested branch before denying a sibling private writer", async () => {
    const { bucket, db } = await setup();
    bucket.resetReads();

    const responses = await callTargetReads(
      envFor(bucket, db),
      roots.private,
      "sibling",
      writer,
    );

    expect(responses.map(({ status }) => status)).toEqual([404, 404]);
    expect(bucket.reads.branches).toBe(2);
    expect(bucket.reads.branchLists).toBe(0);
    expectNoContentDataReads(bucket);
  });

  it.each([
    ["public", roots.deletedPublic],
    ["unlisted", roots.deletedUnlisted],
    ["private", roots.deletedPrivate],
  ] as Array<[string, string]>)(
    "hides a deleted %s projection from every branch read",
    async (_visibility, root) => {
      const { bucket, db } = await setup();
      const responses = await callAllReads(
        envFor(bucket, db),
        root,
        "owner",
        canonicalOwner,
      );

      expect(responses.map(({ status }) => status)).toEqual([404, 404, 404]);
      await Promise.all(
        responses.map(async (response) =>
          expect(await response.text()).toBe("Branch not found."),
        ),
      );

      bucket.resetReads();
      const targetResponses = await callTargetReads(
        envFor(bucket, db),
        root,
        "owner",
        canonicalOwner,
      );
      expect(targetResponses.map(({ status }) => status)).toEqual([404, 404]);
      expectNoBranchDataReads(bucket);
    },
  );

  it("denies an invalid bearer without identity fallback", async () => {
    const { bucket, db } = await setup();
    const invalidBearer = await callAllReads(
      envFor(bucket, db),
      roots.private,
      "owner",
      canonicalOwner,
      "invalid-token",
    );
    expect(invalidBearer.map(({ status }) => status)).toEqual([404, 404, 404]);
  });

  it("hides malformed projected visibility from every branch read without enumeration", async () => {
    const { bucket, db } = await setup();
    const responses = await callAllReads(
      envFor(bucket, db),
      roots.malformed,
      "owner",
      canonicalOwner,
    );

    expect(responses.map(({ status }) => status)).toEqual([404, 404, 404]);
    await Promise.all(
      responses.map(async (response) =>
        expect(await response.text()).toBe("Branch not found."),
      ),
    );

    bucket.resetReads();
    const targetResponses = await callTargetReads(
      envFor(bucket, db),
      roots.malformed,
      "owner",
      canonicalOwner,
    );
    expect(targetResponses.map(({ status }) => status)).toEqual([404, 404]);
    expectNoBranchDataReads(bucket);
  });

  it("pins projection-absent and database-absent roots to legacy identifier reads", async () => {
    const { bucket, db } = await setup();
    bucket.resetReads();
    const missingProjection = await callAllReads(
      envFor(bucket, db),
      roots.missing,
    );
    expect(missingProjection.map(({ status }) => status)).toEqual([
      200, 200, 200,
    ]);
    expect(bucket.reads.branchLists).toBeGreaterThan(0);
    expect(bucket.reads.branches).toBeGreaterThan(0);
    expect(bucket.reads.snapshots).toBeGreaterThan(0);
    expect(bucket.reads.checkpoints).toBeGreaterThan(0);

    bucket.resetReads();
    const missingDatabase = await callAllReads(
      envFor(bucket),
      roots.noDatabase,
    );
    expect(missingDatabase.map(({ status }) => status)).toEqual([
      200, 200, 200,
    ]);
    expect(bucket.reads.branchLists).toBeGreaterThan(0);
    expect(bucket.reads.branches).toBeGreaterThan(0);
    expect(bucket.reads.snapshots).toBeGreaterThan(0);
    expect(bucket.reads.checkpoints).toBeGreaterThan(0);
  });
});

describe("branch resolution authorization", () => {
  it("returns 401 before resolving an unauthenticated alias request", async () => {
    const { bucket, db } = await setup();
    const shortId = "ReAu01";
    await bucket.put(createRemoteAliasKey(shortId), roots.private);
    bucket.resetReads();
    bucket.resetWrites();

    const response = await call(resolveBranch, envFor(bucket, db), {
      id: shortId,
    });

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe(
      "Authenticated account session is required.",
    );
    expect(bucket.aliasReads).toBe(0);
    expectNoBranchDataReads(bucket);
    expectNoBranchDataWrites(bucket);
  });

  it("does not initialize an unrelated private clone through an R2-only alias", async () => {
    const { bucket, db } = await setup();
    const shortId = "RePr01";
    const writerKey = createWriterKey(unrelated, null);
    const branchId = createCloneBranchId(writerKey);
    await bucket.put(createRemoteAliasKey(shortId), roots.private);
    bucket.resetReads();
    bucket.resetWrites();

    const response = await call(
      resolveBranch,
      envFor(bucket, db),
      { id: shortId },
      unrelated,
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Branch not found.");
    expect(db.runs).toBe(0);
    expectNoBranchDataReads(bucket);
    expectNoBranchDataWrites(bucket);
    expect(bucket.has(createBranchKey(roots.private, branchId))).toBe(false);
    expect(bucket.has(createWriterBranchKey(roots.private, writerKey))).toBe(
      false,
    );
  });

  it.each([
    ["deleted", roots.deletedPrivate],
    ["malformed", roots.malformed],
  ] as Array<[string, string]>)(
    "does not initialize a clone for a %s root",
    async (_label, rootDropId) => {
      const { bucket, db } = await setup();
      const writerKey = createWriterKey(unrelated, null);
      const branchId = createCloneBranchId(writerKey);
      bucket.resetReads();
      bucket.resetWrites();

      const response = await call(
        resolveBranch,
        envFor(bucket, db),
        { id: rootDropId },
        unrelated,
      );

      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe("Branch not found.");
      expectNoBranchDataReads(bucket);
      expectNoBranchDataWrites(bucket);
      expect(bucket.has(createBranchKey(rootDropId, branchId))).toBe(false);
      expect(bucket.has(createWriterBranchKey(rootDropId, writerKey))).toBe(
        false,
      );
    },
  );

  it("allows the canonical owner to resolve the private owner branch", async () => {
    const { bucket, db } = await setup();

    const response = await call(
      resolveBranch,
      envFor(bucket, db),
      { id: roots.private },
      canonicalOwner,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      rootDropId: roots.private,
      branchId: "owner",
      mode: "owner",
      created: false,
    });
  });
});

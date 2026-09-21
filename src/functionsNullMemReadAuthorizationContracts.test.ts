import { describe, expect, it } from "@jest/globals";
import type { R2Bucket } from "@cloudflare/workers-types";
import { onRequestGet as queryNullMemRoute } from "../functions/api/branches/[rootId]/[branchId]/memory/query";
import { createBranchKey } from "../functions/api/_lib/branches/storage/keys";
import { createRemoteAliasKey } from "../functions/api/_lib/drops/identity/id";
import { queryNullMem } from "../functions/api/_lib/nullmem/httpController";
import { NULLPLUG_REGISTRY_LATEST_KEY_PREFIX } from "../shared/nullplug/registry";
import { NULLPLUG_INVOKE_CONTENT_TYPE } from "../shared/nullplug/protocol";
import { createNullMemFreshnessWatermarkKey } from "./server/nulledit";
import type { DropBranchRecord } from "../shared/drop/branch";
import type { NullMemRecord } from "../shared/nullmem/types";
import type {
  BranchMemoryService,
  BranchMemoryQueryRequest,
} from "./server/runtime";
import type {
  BlobObjectBody,
  BlobObject,
  BlobObjectStore,
  SqlBindableValue,
  SqlStatement,
  SqlMetadataStore,
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

const roots = {
  public: "NullMemPublicRoot",
  unlisted: "NullMemUnlistedRoot",
  private: "NullMemPrivateRoot",
  deletedPublic: "NullMemDeletedPublic",
  deletedUnlisted: "NullMemDeletedUnlisted",
  deletedPrivate: "NullMemDeletedPrivate",
  malformed: "NullMemMalformedRoot",
  legacy: "NullMemLegacyRoot",
} as const;

const owner = "account-owner";
const writer = "account-writer";
const siblingWriter = "account-sibling";
const unrelated = "account-unrelated";
const forgedOwner = "account-forged-owner";

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

const makeBranch = (
  rootDropId: string,
  branchId: string,
  writerAccountId: string | null,
  ownerAccountId: string | null = owner,
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
  headSnapshotId: 7,
  createdAt: 1,
  updatedAt: 1,
});

class InstrumentedBlobStore implements BlobObjectStore {
  private readonly objects = new Map<string, string>();
  private branchReads = 0;
  readonly events: string[];

  constructor(events: string[]) {
    this.events = events;
  }

  async get(key: string): Promise<BlobObject | null> {
    if (key.startsWith("__drop_branch__/")) {
      this.events.push(this.branchReads++ === 0 ? "branch" : "freshness-head");
    }
    if (key.startsWith(NULLPLUG_REGISTRY_LATEST_KEY_PREFIX)) {
      this.events.push("catalog-blob");
    }
    const value = this.objects.get(key);
    return value === undefined
      ? null
      : {
          key,
          text: async () => value,
          json: async <T>() => JSON.parse(value) as T,
        };
  }

  async head(key: string) {
    return this.objects.has(key) ? { key } : null;
  }

  async put(key: string, value: BlobObjectBody) {
    const text =
      typeof value === "string"
        ? value
        : await new Response(value as BodyInit | null).text();
    this.objects.set(key, text);
    return { key };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys])
      this.objects.delete(key);
  }

  async list(options?: { prefix?: string }) {
    if (options?.prefix === NULLPLUG_REGISTRY_LATEST_KEY_PREFIX) {
      this.events.push("catalog-list");
    }
    const prefix = options?.prefix ?? "";
    return {
      objects: [...this.objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key })),
      truncated: false,
    };
  }
}

class InstrumentedDatabase implements SqlMetadataStore {
  readonly records: NullMemRecord[] = [];
  runs = 0;
  watermarkHeadSnapshotId = 9;

  constructor(
    private readonly rows: Map<string, ProjectionRow>,
    private readonly events: string[],
  ) {}

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
          this.events.push("root");
          return (this.rows.get(String(values[0])) as T | undefined) ?? null;
        }
        if (sql.includes("FROM void_data_records")) {
          this.events.push("watermark");
          return {
            record_json: JSON.stringify({
              key: createNullMemFreshnessWatermarkKey(roots.public, "owner"),
              value: {
                version: 1,
                rootDropId: roots.public,
                branchId: "owner",
                headSnapshotId: this.watermarkHeadSnapshotId,
                previousSnapshotId: 8,
                updatedAt: 10,
                acceptedEventCount: 1,
              },
              updatedAt: 10,
            }),
          } as T;
        }
        return null;
      },
      all: async <T>() => {
        if (sql.includes("FROM nullmem_records")) {
          this.events.push("memory");
          const requestedKind =
            values.length === 4 ? String(values[2]) : undefined;
          return {
            results: this.records
              .filter(
                (record) => !requestedKind || record.kind === requestedKind,
              )
              .map((record) => ({
                record_json: JSON.stringify(record),
              })) as T[],
          };
        }
        return { results: [] as T[] };
      },
    };
    return statement;
  }
}

const privateFact: NullMemRecord = {
  version: 1,
  kind: "fact",
  recordId: "fact-private",
  text: "private fact",
  labels: ["private-memory"],
  createdAt: 1,
};
const publicFact: NullMemRecord = {
  version: 1,
  kind: "fact",
  recordId: "fact-public",
  text: "public fact",
  labels: ["public-memory"],
  createdAt: 2,
};
const privateProcedure: NullMemRecord = {
  version: 1,
  kind: "procedure",
  recordId: "procedure-private",
  goal: "private procedure",
  summary: "private procedure",
  steps: [],
  outcome: "success",
  labels: ["private-memory"],
  createdAt: 3,
};
const publicProcedure: NullMemRecord = {
  ...privateProcedure,
  recordId: "procedure-public",
  goal: "public procedure",
  summary: "public procedure",
  labels: ["public-memory"],
  createdAt: 4,
};
const privateCapability: NullMemRecord = {
  version: 1,
  kind: "capability",
  recordId: "capability-private",
  capabilityKind: "tool",
  capabilityId: "private",
  description: "private capability",
  labels: ["private-memory"],
  createdAt: 5,
};
const publicCapability: NullMemRecord = {
  ...privateCapability,
  recordId: "capability-public",
  capabilityId: "public",
  description: "public capability",
  labels: ["public-memory"],
  sourceRefs: [
    {
      kind: "snapshot",
      rootDropId: roots.public,
      branchId: "owner",
      snapshotId: 5,
    },
  ],
  createdAt: 6,
};
const allRecords = [
  privateFact,
  publicFact,
  privateProcedure,
  publicProcedure,
  privateCapability,
  publicCapability,
];

class InstrumentedMemory implements BranchMemoryService {
  readonly queries: BranchMemoryQueryRequest[] = [];

  constructor(private readonly events: string[]) {}

  async query(request: BranchMemoryQueryRequest) {
    this.events.push("memory");
    this.queries.push(request);
    const records = allRecords.filter(
      (record) =>
        (!request.kind || record.kind === request.kind) &&
        (request.labels ?? []).every((label) => record.labels?.includes(label)),
    );
    return {
      rootDropId: request.rootDropId,
      branchId: request.branchId,
      query: {
        q: request.q,
        kind: request.procedureId ? "procedure" : request.kind,
        labels: request.labels,
        limit: request.limit,
        procedureId: request.procedureId,
        afterStep: request.afterStep,
        stepLimit: request.stepLimit,
      },
      capsules: [],
      records,
      procedureSteps: request.procedureId
        ? [
            {
              procedureId: request.procedureId,
              goal: "paged procedure",
              summary: "paged procedure",
              step: {
                index: 1,
                kind: "query" as const,
                name: "next",
                status: "success" as const,
              },
              remainingSteps: 0,
            },
          ]
        : undefined,
      freshness: request.includeFreshness ? [] : undefined,
    };
  }

  async createFact(): Promise<never> {
    throw new Error("not used");
  }

  async createProcedure(): Promise<never> {
    throw new Error("not used");
  }

  async delete(): Promise<never> {
    throw new Error("not used");
  }
}

const setup = async () => {
  const events: string[] = [];
  const bucket = new InstrumentedBlobStore(events);
  const rows = new Map<string, ProjectionRow>([
    [roots.public, projection(roots.public, "public")],
    [roots.unlisted, projection(roots.unlisted, "unlisted")],
    [roots.private, projection(roots.private, "private")],
    [roots.deletedPublic, projection(roots.deletedPublic, "public", 2)],
    [roots.deletedUnlisted, projection(roots.deletedUnlisted, "unlisted", 2)],
    [roots.deletedPrivate, projection(roots.deletedPrivate, "private", 2)],
    [
      roots.malformed,
      { ...projection(roots.malformed, "public"), visibility: "invalid" },
    ],
  ]);
  const db = new InstrumentedDatabase(rows, events);
  const memory = new InstrumentedMemory(events);
  for (const rootDropId of Object.values(roots)) {
    await bucket.put(
      createBranchKey(rootDropId, "owner"),
      JSON.stringify(makeBranch(rootDropId, "owner", owner)),
    );
  }
  await bucket.put(
    createBranchKey(roots.private, "writer"),
    JSON.stringify(makeBranch(roots.private, "writer", writer, forgedOwner)),
  );
  for (const rootDropId of [roots.public, roots.unlisted]) {
    await bucket.put(
      createBranchKey(rootDropId, "writer"),
      JSON.stringify(makeBranch(rootDropId, "writer", writer, forgedOwner)),
    );
  }
  await bucket.put(
    createBranchKey(roots.private, "sibling"),
    JSON.stringify(
      makeBranch(roots.private, "sibling", siblingWriter, forgedOwner),
    ),
  );
  await bucket.put(
    createBranchKey(roots.legacy, "writer"),
    JSON.stringify(makeBranch(roots.legacy, "writer", writer, forgedOwner)),
  );
  events.length = 0;
  return { events, bucket, db, memory };
};

const call = (
  setupResult: Awaited<ReturnType<typeof setup>>,
  rootDropId: string,
  branchId = "owner",
  accountId?: string,
  query = "",
  bearer?: string,
): Promise<Response> => {
  const headers = new Headers();
  if (accountId) headers.set("x-nulldown-account-id", accountId);
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
  return queryNullMem(
    {
      R2_BUCKET: setupResult.bucket,
      DB: setupResult.db,
      ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      ACCOUNT_AUTH_SECRET: "test-secret",
    },
    { rootId: rootDropId, branchId },
    new Request(`https://nulldown.test/api/memory/query${query}`, { headers }),
    { memory: setupResult.memory },
  );
};

const responseRecords = async (response: Response): Promise<string[]> => {
  const body = (await response.json()) as {
    records: Array<{ recordId: string }>;
  };
  return body.records.map(({ recordId }) => recordId);
};

const expectGenericBranch404 = async (response: Response): Promise<void> => {
  expect(response.status).toBe(404);
  await expect(response.json()).resolves.toEqual({
    error: "Branch not found.",
    code: "branch_not_found",
  });
};

const callGetAdapter = (
  state: Awaited<ReturnType<typeof setup>>,
  accountId?: string,
  q = "remote-tool",
): Promise<Response> => {
  const headers = new Headers();
  if (accountId) headers.set("x-nulldown-account-id", accountId);
  return Promise.resolve(
    queryNullMemRoute({
      request: new Request(
        `https://nulldown.test/api/branches/root/owner/memory/query?kind=capability&q=${q}&includeFreshness=true`,
        { headers },
      ),
      env: {
        R2_BUCKET: state.bucket as unknown as R2Bucket,
        DB: state.db,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      params: { rootId: roots.public, branchId: "owner" },
    } as never),
  );
};

describe("NullMem GET read authorization", () => {
  it.each([
    ["private", "NmPr01", roots.private, undefined],
    ["tombstoned", "NmDe01", roots.deletedPublic, owner],
    ["malformed", "NmBa01", roots.malformed, owner],
  ] as Array<[string, string, string, string | undefined]>)(
    "resolves an R2-only alias for a denied %s root without SQL writes or downstream reads",
    async (_label, shortId, rootDropId, accountId) => {
      const state = await setup();
      await state.bucket.put(createRemoteAliasKey(shortId), rootDropId);
      state.events.length = 0;

      await expectGenericBranch404(
        await call(state, shortId, "owner", accountId),
      );
      expect(state.db.runs).toBe(0);
      expect(state.events).toEqual(["root"]);
    },
  );

  it("resolves an allowed R2-only short alias to its canonical root", async () => {
    const state = await setup();
    await state.bucket.put(createRemoteAliasKey("NmPu01"), roots.public);
    state.events.length = 0;

    const response = await call(state, "NmPu01");
    expect(response.status).toBe(200);
    expect(state.memory.queries[0]).toMatchObject({ rootDropId: roots.public });
    expect(state.db.runs).toBe(0);
  });

  it.each([roots.public, roots.unlisted])(
    "filters anonymous and unrelated readers on live identifier-readable root %s",
    async (rootDropId) => {
      for (const accountId of [undefined, unrelated]) {
        const state = await setup();
        const response = await call(state, rootDropId, "owner", accountId);
        expect(response.status).toBe(200);
        await expect(responseRecords(response)).resolves.toEqual([
          "fact-public",
          "procedure-public",
          "capability-public",
        ]);
        expect(state.memory.queries[0]?.labels).toEqual(["public-memory"]);
        expect(state.events.indexOf("root")).toBeLessThan(
          state.events.indexOf("branch"),
        );
        expect(state.events.indexOf("branch")).toBeLessThan(
          state.events.indexOf("memory"),
        );
      }
    },
  );

  it.each([roots.public, roots.unlisted, roots.private])(
    "allows canonical owner and exact writer full fact, procedure, and capability reads on %s",
    async (rootDropId) => {
      for (const [branchId, accountId] of [
        ["owner", owner],
        ["writer", writer],
      ] as const) {
        const state = await setup();
        const response = await call(state, rootDropId, branchId, accountId);
        expect(response.status).toBe(200);
        await expect(responseRecords(response)).resolves.toEqual(
          allRecords.map(({ recordId }) => recordId),
        );
        expect(state.memory.queries[0]?.labels).toEqual([]);
      }
    },
  );

  it("hides private branches from anonymous, unrelated, sibling, and forged legacy owners before memory reads", async () => {
    const cases = [
      ["owner", undefined, 0],
      ["owner", unrelated, 1],
      ["sibling", writer, 1],
      ["writer", forgedOwner, 1],
    ] as const;
    for (const [branchId, accountId, expectedBranchReads] of cases) {
      const state = await setup();
      await expectGenericBranch404(
        await call(state, roots.private, branchId, accountId),
      );
      expect(state.events.filter((event) => event === "branch")).toHaveLength(
        expectedBranchReads,
      );
      expect(state.events).not.toContain("memory");
      expect(state.events).not.toContain("catalog-list");
    }
  });

  it.each([
    roots.deletedPublic,
    roots.deletedUnlisted,
    roots.deletedPrivate,
    roots.malformed,
  ])(
    "hides denied projected root %s before branch, memory, catalog, or freshness reads",
    async (rootDropId) => {
      const state = await setup();
      await expectGenericBranch404(
        await call(
          state,
          rootDropId,
          "owner",
          owner,
          "?includeFreshness=true&kind=capability",
        ),
      );
      expect(state.events).toEqual(["root"]);
    },
  );

  it("keeps projection-absent roots public-memory filtered except for the exact writer", async () => {
    for (const [branchId, accountId, expectedLabels] of [
      ["owner", undefined, ["public-memory"]],
      ["owner", unrelated, ["public-memory"]],
      ["owner", forgedOwner, ["public-memory"]],
      ["writer", writer, []],
    ] as const) {
      const state = await setup();
      const response = await call(state, roots.legacy, branchId, accountId);
      expect(response.status).toBe(200);
      expect(state.memory.queries[0]?.labels).toEqual(expectedLabels);
    }
  });

  it("does not fall back to the dev account header when a bearer is invalid", async () => {
    const privateState = await setup();
    await expectGenericBranch404(
      await call(
        privateState,
        roots.private,
        "owner",
        owner,
        "",
        "invalid-token",
      ),
    );
    expect(privateState.events).toEqual(["root"]);

    const publicState = await setup();
    const response = await call(
      publicState,
      roots.public,
      "owner",
      owner,
      "",
      "invalid-token",
    );
    expect(response.status).toBe(200);
    expect(publicState.memory.queries[0]?.labels).toEqual(["public-memory"]);
  });

  it("classifies authorization before procedure projection and freshness options are forwarded", async () => {
    const denied = await setup();
    await expectGenericBranch404(
      await call(
        denied,
        roots.private,
        "owner",
        unrelated,
        "?procedureId=procedure-private&afterStep=0&stepLimit=1&includeRecords=false&includeFreshness=true",
      ),
    );
    expect(denied.memory.queries).toHaveLength(0);

    const allowed = await setup();
    const response = await call(
      allowed,
      roots.private,
      "owner",
      owner,
      "?procedureId=procedure-private&afterStep=0&stepLimit=1&includeRecords=false&includeFreshness=true",
    );
    const body = (await response.json()) as { procedureSteps: unknown[] };
    expect(response.status).toBe(200);
    expect(body.procedureSteps).toHaveLength(1);
    expect(allowed.memory.queries[0]).toEqual(
      expect.objectContaining({
        procedureId: "procedure-private",
        afterStep: 0,
        stepLimit: 1,
        includeRecords: false,
        includeFreshness: true,
      }),
    );
    expect(allowed.events.indexOf("branch")).toBeLessThan(
      allowed.events.indexOf("memory"),
    );
  });

  it("returns SQL-required 500 before root or branch access", async () => {
    const state = await setup();
    const response = await queryNullMem(
      { R2_BUCKET: state.bucket },
      { rootId: roots.public, branchId: "owner" },
      new Request("https://nulldown.test/api/memory/query"),
      { memory: state.memory },
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "SQL metadata store is required to use memory.",
      code: "sql_store_required",
    });
    expect(state.events).toEqual([]);
  });

  it("uses Cloudflare freshness data without exposing remote catalogs to public readers", async () => {
    const state = await setup();
    state.db.records.push(publicCapability);
    await state.bucket.put(
      `${NULLPLUG_REGISTRY_LATEST_KEY_PREFIX}remote-tool.json`,
      JSON.stringify({
        version: 1,
        manifest: {
          id: "remote-tool",
          version: "1.0.0",
          endpoint: "https://tools.example.test/invoke",
          contentType: NULLPLUG_INVOKE_CONTENT_TYPE,
          inputSchema: {},
          outputSchema: {},
          permissions: [],
          description: "Remote tool catalog fixture.",
        },
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    state.events.length = 0;

    const publicResponse = await callGetAdapter(state, undefined, "public");
    expect(publicResponse.status).toBe(200);
    const publicBody = (await publicResponse.json()) as {
      records: Array<{ recordId: string }>;
      freshness: Array<{ currentSnapshotId?: number }>;
    };
    expect(publicBody.records.map(({ recordId }) => recordId)).toEqual([
      "capability-public",
    ]);
    expect(publicBody.freshness).toEqual([
      expect.objectContaining({ currentSnapshotId: 9 }),
    ]);
    expect(state.events).not.toContain("catalog-list");
    expect(state.events).not.toContain("catalog-blob");
    expect(state.events).toContain("watermark");
    expect(state.events).not.toContain("freshness-head");
    expect(state.events.indexOf("branch")).toBeLessThan(
      state.events.indexOf("memory"),
    );

    state.events.length = 0;
    const sensitiveResponse = await callGetAdapter(state, owner);
    expect(sensitiveResponse.status).toBe(200);
    const sensitiveBody = (await sensitiveResponse.json()) as {
      records: Array<{ recordId: string }>;
      freshness: Array<{ currentSnapshotId?: number }>;
    };
    expect(sensitiveBody.records.map(({ recordId }) => recordId)).toContain(
      "capability:nullplug:remote-tool:1.0.0",
    );
    expect(sensitiveBody.freshness).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordId: "capability:nullplug:remote-tool:1.0.0",
          currentSnapshotId: 9,
        }),
      ]),
    );
    expect(state.events).toContain("catalog-list");
    expect(state.events).toContain("catalog-blob");
    expect(state.events).toContain("watermark");
    expect(
      state.events.filter((event) => event === "freshness-head"),
    ).toHaveLength(1);
  });

  it("reads the freshness head only after an authorized filtered memory query", async () => {
    const state = await setup();
    const response = await queryNullMem(
      {
        R2_BUCKET: state.bucket,
        DB: state.db,
        ALLOW_INSECURE_ACCOUNT_HEADER: "1",
      },
      { rootId: roots.public, branchId: "owner" },
      new Request(
        "https://nulldown.test/api/memory/query?kind=fact&includeFreshness=true",
      ),
    );
    expect(response.status).toBe(200);
    expect(state.events).toContain("freshness-head");
    expect(state.events.indexOf("memory")).toBeLessThan(
      state.events.indexOf("freshness-head"),
    );
  });
});

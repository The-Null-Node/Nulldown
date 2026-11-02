import { afterEach, describe, expect, it, jest } from "@jest/globals";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { onRequest as factsRequest } from "../../branches/[rootId]/[branchId]/memory/facts";
import { onRequest as proceduresRequest } from "../../branches/[rootId]/[branchId]/memory/procedures";
import { onRequest as queryRequest } from "../../branches/[rootId]/[branchId]/memory/query";
import { onRequest as deleteRequest } from "../../branches/[rootId]/[branchId]/memory/[recordId]";
import { BranchStateError } from "../../../../shared/drop/branch-state";
import type { BranchNullMemStatePlane } from "../../../../shared/drop/branch-nullmem";
import type {
  NullMemFactRecord,
  NullMemProcedureRecord,
  NullMemRecord,
} from "../../../../shared/nullmem/records";
import type {
  BranchMemoryQueryResult,
  BranchMemoryWriteResult,
} from "../../../../src/server/runtime";
import { MemoryBranchCommitStatePlane } from "../../../../src/server/state-plane/memory-commits";
import { createLocalBranchLifecycle } from "../../../../src/server/state-plane/application-lifecycle";
import type { LocalBranchApplicationSelection } from "../../../../src/server/state-plane/commit-application";
import type {
  BlobObjectStore,
  SqlMetadataStore,
} from "../../../../src/server/ports";
import {
  MemoryD1Database,
  MemoryR2Bucket,
} from "../diffs/testing/storage-fixture";
import { createRemoteAliasKey } from "../drops/identity/id";

const rootDropId = "LocalMemoryRoot01";
const owner = "account-owner";
const writer = "account-writer";
const outsider = "account-outsider";
const placement = { routingVersion: 1, generation: 3 };
const content = "# Initial memory source\n";

const fixture = async () => {
  const blobs = new MemoryR2Bucket();
  const db = new MemoryD1Database();
  const clock = jest.fn(() => 1000);
  const backend = await MemoryBranchCommitStatePlane.create([], clock);
  const initialize = async (actor: string, branchOwner = owner) => {
    const target = {
      rootDropId,
      branchId: actor === owner ? "owner" : `clone_account:${actor}`,
    };
    const command = {
      target,
      placement,
      reservationId: `reservation-${actor}`,
      rootRevision: "root-revision-1",
    };
    await backend.reserve({
      ...command,
      identity: {
        baseDropId: rootDropId,
        mode: actor === owner ? "owner" : "clone",
        ownerAccountId: branchOwner,
        writerAccountId: actor,
        writerClientId: null,
      },
    });
    await backend.initialize({ ...command, content });
    return target.branchId;
  };
  const branchId = await initialize(writer);
  const target = { rootDropId, branchId };
  const query = { target, placement };
  const project = (
    visibility: unknown = "private",
    deletedAt: number | null = null,
    accountId = owner,
  ) => {
    db.accountLibraryEntries.set(rootDropId, {
      entry_seq: 1,
      drop_id: rootDropId,
      account_id: accountId,
      visibility,
      created_at: 1,
      updated_at: 1,
      deleted_at: deletedAt,
    });
  };
  project();
  const memory: BranchNullMemStatePlane = backend;
  const selection: LocalBranchApplicationSelection = {
    mode: "local-test",
    placement,
    commits: backend,
    history: backend,
    nullmem: { backend: memory },
    lifecycle: createLocalBranchLifecycle({
      mode: "local-test",
      blobs: blobs as unknown as BlobObjectStore,
      sql: db as unknown as SqlMetadataStore,
      backend,
      initialPlacement: placement,
      isEligibleRoot: (id) => id === rootDropId,
    }),
  };
  const env = {
    R2_BUCKET: blobs as unknown as R2Bucket,
    DB: db as unknown as D1Database,
    ALLOW_INSECURE_ACCOUNT_HEADER: "1",
    ACCOUNT_AUTH_SECRET: "local-memory-test-secret",
    localBranchApplication: selection,
  };
  type Route = "facts" | "procedures" | "query" | "delete";
  const call = async (
    route: Route,
    options: {
      body?: unknown;
      account?: string | null;
      search?: string;
      recordId?: string;
      rootId?: string;
      branchId?: string;
      bearer?: string;
    } = {},
  ): Promise<Response> => {
    const account = options.account === undefined ? writer : options.account;
    const requestedRoot = options.rootId ?? rootDropId;
    const requestedBranch = options.branchId ?? branchId;
    const recordId = encodeURIComponent(options.recordId ?? "missing");
    const method =
      route === "query" ? "GET" : route === "delete" ? "DELETE" : "POST";
    const handler = {
      facts: factsRequest,
      procedures: proceduresRequest,
      query: queryRequest,
      delete: deleteRequest,
    }[route];
    return (await handler({
      env,
      params: { rootId: requestedRoot, branchId: requestedBranch, recordId },
      request: new Request(
        `https://nulldown.test/api/branches/${requestedRoot}/${encodeURIComponent(requestedBranch)}/memory/${route === "delete" ? recordId : route}${options.search ? `?${options.search}` : ""}`,
        {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(account === null ? {} : { "x-nulldown-account-id": account }),
            ...(options.bearer
              ? { Authorization: `Bearer ${options.bearer}` }
              : {}),
          },
          ...(method === "POST"
            ? { body: JSON.stringify(options.body ?? {}) }
            : {}),
        },
      ),
    } as never)) as unknown as Response;
  };
  const read = async (search = "", account: string | null = writer) => {
    const response = await call("query", { search, account });
    expect({
      status: response.status,
      error: response.ok ? null : await response.clone().text(),
    }).toEqual({ status: 200, error: null });
    return (await response.json()) as BranchMemoryQueryResult;
  };
  const writeFact = async (body: unknown) => {
    const response = await call("facts", { body });
    expect({
      status: response.status,
      error: response.ok ? null : await response.clone().text(),
    }).toEqual({ status: 201, error: null });
    return (await response.json()) as BranchMemoryWriteResult<NullMemFactRecord>;
  };
  const writeProcedure = async (body: unknown) => {
    const response = await call("procedures", { body });
    expect({
      status: response.status,
      error: response.ok ? null : await response.clone().text(),
    }).toEqual({ status: 201, error: null });
    return (await response.json()) as BranchMemoryWriteResult<NullMemProcedureRecord>;
  };
  const edit = () =>
    backend.appendBatch({
      ...query,
      events: [
        {
          eventId: "edit-1",
          dropId: rootDropId,
          seq: 0,
          sourceClientId: "client-1",
          createdAt: 20,
          ops: [{ type: "insert", start: 0, end: 0, text: "Changed\n" }],
          metadata: { followsSeq: -1 },
        },
      ],
    });
  const prepare = jest.spyOn(db, "prepare");
  const putBlob = jest.spyOn(blobs, "put");
  const deleteBlob = jest.spyOn(blobs, "delete");
  const queryMemory = jest.spyOn(backend, "queryNullMem");
  const putMemory = jest.spyOn(backend, "putNullMem");
  const deleteMemory = jest.spyOn(backend, "deleteNullMem");
  const assertNoLegacyMemory = () => {
    expect(putBlob).not.toHaveBeenCalled();
    expect(deleteBlob).not.toHaveBeenCalled();
    expect(db.runCalls).toBe(0);
    expect(db.batchCalls).toEqual([]);
    expect(blobs.listCalls).toEqual([]);
    expect(blobs.getCalls).not.toContain(rootDropId);
    expect(
      blobs.getCalls.filter((key) => key.startsWith("__drop_branch__/")),
    ).toEqual([]);
    expect(
      prepare.mock.calls.filter(([sql]) =>
        /nullmem_records|void_data_records/i.test(sql),
      ),
    ).toEqual([]);
  };
  return {
    clock,
    backend,
    selection,
    blobs,
    db,
    target,
    query,
    branchId,
    initialize,
    project,
    call,
    read,
    writeFact,
    writeProcedure,
    edit,
    prepare,
    queryMemory,
    putMemory,
    deleteMemory,
    assertNoLegacyMemory,
  };
};

describe("selected local NullMem through actual Pages routes", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("upserts mutable IDs independently by kind, deletes all kinds, and recreates without public receipt fields", async () => {
    const f = await fixture();
    const clock = f.clock.mockReturnValue(2000);
    const first = await f.writeFact({
      recordId: "shared/id:雪",
      text: "first",
      labels: ["test"],
    });
    expect(Object.keys(first).sort()).toEqual([
      "branchId",
      "record",
      "rootDropId",
    ]);
    expect(first.record.createdAt).toBe(2000);
    clock.mockReturnValue(3000);
    const updated = await f.writeFact({
      recordId: first.record.recordId,
      text: "changed",
      labels: ["test"],
    });
    expect(updated.record).toMatchObject({ text: "changed", createdAt: 3000 });
    clock.mockReturnValue(4000);
    const retry = await f.writeFact({
      recordId: first.record.recordId,
      text: "changed",
      labels: ["test"],
    });
    expect(retry.record.createdAt).toBe(4000);
    await f.writeProcedure({
      recordId: first.record.recordId,
      goal: "goal",
      summary: "first",
      labels: ["test"],
    });
    clock.mockReturnValue(5000);
    const procedure = await f.writeProcedure({
      recordId: first.record.recordId,
      goal: "goal",
      summary: "updated",
      labels: ["test"],
    });
    expect(procedure.record).toMatchObject({
      summary: "updated",
      steps: [],
      outcome: "success",
      createdAt: 5000,
    });
    expect(
      (await f.read("labels=test")).records.map((record) => record.kind),
    ).toEqual(["procedure", "fact"]);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const removed = await f.call("delete", {
        recordId: first.record.recordId,
      });
      expect(removed.status).toBe(200);
      expect(await removed.json()).toEqual({
        ...f.target,
        recordId: first.record.recordId,
      });
    }
    expect((await f.read("labels=test")).records).toEqual([]);
    clock.mockReturnValue(6000);
    expect(
      (
        await f.writeFact({
          recordId: first.record.recordId,
          text: "recreated",
          labels: ["test"],
        })
      ).record.createdAt,
    ).toBe(6000);
    expect((await f.read("labels=test")).records).toHaveLength(1);
    expect((await f.backend.readHead(f.query)).version.snapshotId).toBe(0);
    f.assertNoLegacyMemory();
  });

  it("generates IDs, preserves explicit empty refs and nested extensions, and derives actor and scope server-side", async () => {
    const f = await fixture();
    const first = await f.writeFact({
      text: "generated",
      actorAccountId: outsider,
      rootDropId: "forged",
      branchId: "forged",
    });
    const second = await f.writeFact({ text: "generated" });
    expect(first.record.recordId).toMatch(/^memfact:/);
    expect(second.record.recordId).not.toBe(first.record.recordId);
    expect(first.record.sourceRefs).toEqual([{ kind: "branch", ...f.target }]);
    expect(f.putMemory.mock.calls[0][0]).toMatchObject({
      ...f.query,
      actorAccountId: writer,
      record: { ...f.target },
    });
    const empty = await f.writeFact({ text: "empty refs", sourceRefs: [] });
    expect(empty.record.sourceRefs).toEqual([]);
    const sourceRefs = [
      {
        kind: "snapshot",
        ...f.target,
        snapshotId: 0,
        extension: { exact: [" raw ", "雪", "\ud800"] },
      },
    ];
    const steps = [
      {
        index: 0.5,
        kind: "query",
        name: "query",
        status: "success",
        extension: { retained: true },
        callHint: { target: "mcp", name: "memory_query", extension: ["raw"] },
        refs: sourceRefs,
      },
    ];
    const procedure = await f.writeProcedure({
      goal: "preserve",
      summary: "nested",
      sourceRefs,
      steps,
      metadata: { nested: { array: [1, null, " raw "] } },
      labels: ["extensions"],
    });
    expect(procedure.record.recordId).toMatch(/^memproc:/);
    expect(procedure.record.sourceRefs).toEqual(sourceRefs);
    expect(procedure.record.steps).toEqual(steps);
    expect((await f.read("labels=extensions")).records).toEqual([
      procedure.record,
    ]);
    f.assertNoLegacyMemory();
  });

  it.each(["public", "unlisted"])(
    "filters %s anonymous and unrelated reads before capsules and procedure projection",
    async (visibility) => {
      const f = await fixture();
      f.project(visibility);
      await f.writeFact({
        recordId: "private",
        text: "secret",
        labels: ["group"],
        priority: 100,
      });
      await f.writeFact({
        recordId: "public",
        text: "shared",
        labels: ["group", "public-memory"],
      });
      await f.writeProcedure({
        recordId: "private-procedure",
        goal: "secret",
        summary: "secret",
        steps: [],
      });
      for (const account of [null, outsider]) {
        const result = await f.read(
          "labels=group&limit=1&includeFreshness=true",
          account,
        );
        expect(result.records.map((record) => record.recordId)).toEqual([
          "public",
        ]);
        expect(result.query.labels).toEqual(["group", "public-memory"]);
        expect(
          result.capsules.map((capsule) => capsule.record.recordId),
        ).toEqual(["public"]);
        expect(result.freshness?.map((report) => report.recordId)).toEqual([
          "public",
        ]);
        const hidden = await f.read(
          "procedureId=private-procedure&includeFreshness=true",
          account,
        );
        expect(hidden.capsules).toEqual([]);
        expect(hidden.procedureSteps).toEqual([]);
        expect(hidden.freshness).toEqual([]);
      }
      for (const account of [owner, writer]) {
        expect(
          (await f.read("labels=group", account)).records.map(
            (record) => record.recordId,
          ),
        ).toEqual(["private", "public"]);
      }
      f.assertNoLegacyMemory();
    },
  );

  it("denies private sibling and forged owners before memory reads and writes", async () => {
    const f = await fixture();
    const forgedBranch = await f.initialize("other-writer", "forged-owner");
    for (const account of [null, outsider, writer, "forged-owner"]) {
      expect(
        (await f.call("query", { branchId: forgedBranch, account })).status,
      ).toBe(404);
    }
    for (const account of [outsider, writer, "forged-owner"]) {
      expect(
        (
          await f.call("facts", {
            branchId: forgedBranch,
            account,
            body: { text: "forbidden" },
          })
        ).status,
      ).toBe(404);
      expect(
        (await f.call("delete", { branchId: forgedBranch, account })).status,
      ).toBe(404);
    }
    expect(f.queryMemory).not.toHaveBeenCalled();
    expect(f.putMemory).not.toHaveBeenCalled();
    expect(f.deleteMemory).not.toHaveBeenCalled();
    for (const account of [owner, "other-writer"]) {
      expect(
        (
          await f.call("query", {
            branchId: forgedBranch,
            account,
            search: "kind=fact",
          })
        ).status,
      ).toBe(200);
    }
    f.assertNoLegacyMemory();
  });

  it.each([
    { name: "tombstoned", visibility: "private", deletedAt: 2 },
    { name: "malformed", visibility: "unknown", deletedAt: null },
  ])(
    "checks $name root projection before branch, catalog, or memory access",
    async ({ visibility, deletedAt }) => {
      const f = await fixture();
      await f.writeFact({ recordId: "existing", text: "before revocation" });
      f.putMemory.mockClear();
      f.project(visibility, deletedAt);
      const head = jest.spyOn(f.backend, "readHead");
      const catalog = jest.fn(async () => [] as NullMemRecord[]);
      f.selection.nullmem!.catalog = { readRecords: catalog };
      for (const route of ["query", "facts", "procedures", "delete"] as const) {
        expect(
          (
            await f.call(route, {
              recordId: "existing",
              body: {
                recordId: "existing",
                text: "retry",
                goal: "goal",
                summary: "summary",
              },
              search: "includeFreshness=true",
            })
          ).status,
        ).toBe(404);
      }
      expect(head).not.toHaveBeenCalled();
      expect(catalog).not.toHaveBeenCalled();
      expect(f.queryMemory).not.toHaveBeenCalled();
      expect(f.putMemory).not.toHaveBeenCalled();
      expect(f.deleteMemory).not.toHaveBeenCalled();
      f.assertNoLegacyMemory();
    },
  );

  it("retains exact private writer access after canonical ownership changes", async () => {
    const f = await fixture();
    await f.writeFact({ recordId: "existing", text: "initial" });
    f.project("private", null, "replacement-owner");
    f.putMemory.mockClear();
    expect(
      (
        await f.call("facts", {
          account: owner,
          body: { recordId: "existing", text: "old owner" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await f.call("delete", { account: owner, recordId: "existing" })).status,
    ).toBe(404);
    expect(f.putMemory).not.toHaveBeenCalled();
    expect(f.deleteMemory).not.toHaveBeenCalled();
    await f.writeFact({ recordId: "existing", text: "exact writer" });
    expect((await f.read("kind=fact")).records).toEqual([
      expect.objectContaining({ text: "exact writer" }),
    ]);
    f.assertNoLegacyMemory();
  });

  it("keeps projection-absent reads public-filtered except for the exact writer", async () => {
    const f = await fixture();
    await f.writeFact({ recordId: "private", text: "secret" });
    await f.writeFact({
      recordId: "public",
      text: "shared",
      labels: ["public-memory"],
    });
    f.db.accountLibraryEntries.delete(rootDropId);
    for (const account of [null, owner, outsider]) {
      expect(
        (await f.read("kind=fact", account)).records.map(
          (record) => record.recordId,
        ),
      ).toEqual(["public"]);
    }
    expect((await f.read("kind=fact", writer)).records).toHaveLength(2);
    f.assertNoLegacyMemory();
  });

  it("rejects unauthenticated/foreign mutations and invalid bearer fallback before validation or storage", async () => {
    const f = await fixture();
    f.project("public");
    for (const route of ["facts", "procedures", "delete"] as const) {
      expect((await f.call(route, { account: null })).status).toBe(401);
      expect((await f.call(route, { account: outsider })).status).toBe(403);
      expect(
        (await f.call(route, { account: writer, bearer: "invalid-token" }))
          .status,
      ).toBe(401);
    }
    expect(
      (
        await f.call("facts", {
          body: {
            text: "invalid ref",
            sourceRefs: [{ kind: "branch", rootDropId }],
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.call("procedures", {
          body: { goal: "goal", summary: "summary", steps: [{ index: 0 }] },
        })
      ).status,
    ).toBe(400);
    expect(f.putMemory).not.toHaveBeenCalled();
    expect(f.deleteMemory).not.toHaveBeenCalled();
    f.assertNoLegacyMemory();
  });

  it("finds matching labels, lexical text, and exact procedures beyond 500 higher-ranked distractors", async () => {
    const f = await fixture();
    for (let index = 0; index < 505; index += 1) {
      await f.backend.putNullMem({
        ...f.query,
        actorAccountId: writer,
        record: {
          version: 1,
          kind: "procedure",
          ...f.target,
          recordId: `distractor-${index}`,
          goal: "unrelated",
          summary: "unrelated",
          steps: [],
          outcome: "success",
          labels: ["distractor"],
          priority: 100,
          createdAt: 1,
        },
      });
    }
    const matching = await f.writeProcedure({
      recordId: "late-match",
      goal: "Needle target",
      summary: "rare phrase",
      labels: ["selected", "public-memory"],
      priority: -100,
      steps: [{ index: 2.5, kind: "query", name: "next", status: "success" }],
    });
    expect(
      (await f.read("kind=procedure&q=needle%20rare&labels=selected&limit=1"))
        .records,
    ).toEqual([matching.record]);
    f.project("public");
    expect((await f.read("kind=procedure&limit=1", null)).records).toEqual([
      matching.record,
    ]);
    const exact = await f.read("procedureId=late-match&limit=1");
    expect(exact.records).toEqual([]);
    expect(exact.capsules[0].record).toEqual(matching.record);
    expect(exact.procedureSteps).toEqual([
      expect.objectContaining({
        procedureId: "late-match",
        step: { index: 2.5, kind: "query", name: "next", status: "success" },
        remainingSteps: 0,
      }),
    ]);
    f.assertNoLegacyMemory();
  });

  it("preserves ranking, token/label matching, and procedure cursor/default projections", async () => {
    const f = await fixture();
    const clock = f.clock.mockReturnValue(2000);
    for (const recordId of ["z-last", "a-first"]) {
      await f.writeFact({
        recordId,
        text: "Needle",
        labels: ["Case"],
        priority: 2,
      });
    }
    clock.mockReturnValue(3000);
    await f.writeFact({
      recordId: "newest",
      text: "needle",
      labels: ["Case"],
      priority: 2,
    });
    await f.writeFact({
      recordId: "priority",
      text: "needle",
      labels: ["Case"],
      priority: 3,
    });
    expect(
      (await f.read("kind=fact&q=NEEDLE%20x&labels=Case")).records.map(
        (record) => record.recordId,
      ),
    ).toEqual(["priority", "newest", "a-first", "z-last"]);
    expect((await f.read("kind=fact&labels=case")).records).toEqual([]);
    expect((await f.read("kind=fact&q=needle%20missing")).records).toEqual([]);
    const steps = [3, 0.5, 1.5].map((index) => ({
      index,
      kind: "query",
      name: `step-${index}`,
      status: "success",
    }));
    const procedure = await f.writeProcedure({
      recordId: "cursor-procedure",
      goal: "goal",
      summary: "summary",
      steps,
    });
    const first = await f.read("kind=fact&procedureId=cursor-procedure");
    expect(first.query).toMatchObject({
      kind: "procedure",
      limit: 20,
      stepLimit: 1,
    });
    expect(first.records).toEqual([]);
    expect(first.capsules[0].record).toEqual(procedure.record);
    expect(first.procedureSteps).toEqual([
      expect.objectContaining({
        step: { ...steps[1] },
        nextCursor: 0.5,
        remainingSteps: 2,
      }),
    ]);
    const next = await f.read(
      "procedureId=cursor-procedure&afterStep=0.75&stepLimit=2.9&includeRecords=true",
    );
    expect(next.query.stepLimit).toBe(2);
    expect(next.records).toEqual([procedure.record]);
    expect(
      next.procedureSteps?.map(({ step, remainingSteps, nextCursor }) => ({
        index: step.index,
        remainingSteps,
        nextCursor,
      })),
    ).toEqual([
      { index: 1.5, remainingSteps: 1, nextCursor: 1.5 },
      { index: 3, remainingSteps: 0, nextCursor: undefined },
    ]);
    expect(
      (await f.read("procedureId=cursor-procedure&afterStep=3")).procedureSteps,
    ).toEqual([]);
    f.assertNoLegacyMemory();
  });

  it("uses the head captured with the memory query, then reports outdated sources after an edit", async () => {
    const f = await fixture();
    await f.writeFact({
      recordId: "snapshot-fact",
      text: "snapshot fact",
      sourceRefs: [{ kind: "snapshot", ...f.target, snapshotId: 0 }],
    });
    const original = f.queryMemory.getMockImplementation()!.bind(f.backend);
    f.queryMemory.mockImplementationOnce(async (query) => {
      const result = await original(query);
      await f.edit();
      return result;
    });
    const captured = await f.read("kind=fact&includeFreshness=true");
    expect(captured.freshness).toEqual([
      expect.objectContaining({
        recordId: "snapshot-fact",
        status: "fresh",
        currentSnapshotId: 0,
      }),
    ]);
    expect((await f.backend.readHead(f.query)).version.snapshotId).toBe(1);
    const advanced = await f.read("kind=fact&includeFreshness=true");
    expect(advanced.freshness).toEqual([
      expect.objectContaining({
        recordId: "snapshot-fact",
        status: "snapshot-outdated",
        currentSnapshotId: 1,
        outdatedSnapshotRefs: [0],
      }),
    ]);
    f.assertNoLegacyMemory();
  });

  it("skips additional sensitive catalogs for public readers and merges them only for authorized readers", async () => {
    const f = await fixture();
    f.project("public");
    const global: NullMemFactRecord = {
      version: 1,
      kind: "fact",
      recordId: "global-public",
      text: "global",
      labels: ["public-memory", "catalog-test"],
      priority: 2,
      createdAt: 1,
    };
    const remote: NullMemRecord = {
      version: 1,
      kind: "capability",
      recordId: "remote-sensitive",
      capabilityKind: "nullplug",
      capabilityId: "remote",
      description: "remote",
      labels: ["public-memory", "catalog-test"],
      priority: 3,
      createdAt: 1,
    };
    const catalog = jest.fn(
      async ({
        kind,
        canReadSensitive,
      }: {
        kind?: NullMemRecord["kind"];
        canReadSensitive: boolean;
      }) =>
        [global, ...(canReadSensitive ? [remote] : [])].filter(
          (record) => !kind || record.kind === kind,
        ),
    );
    f.selection.nullmem!.catalog = { readRecords: catalog };
    const branch = await f.writeFact({
      recordId: "branch-public",
      text: "branch",
      labels: ["public-memory", "catalog-test"],
      priority: 1,
    });
    for (const account of [null, outsider]) {
      expect(
        (await f.read("labels=catalog-test&limit=1", account)).records,
      ).toEqual([branch.record]);
      expect(catalog).not.toHaveBeenCalled();
    }
    expect((await f.read("labels=catalog-test&limit=1")).records).toEqual([
      remote,
    ]);
    expect(catalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ canReadSensitive: true }),
    );
    f.assertNoLegacyMemory();
  });

  it("uses pure default capabilities without any legacy catalog or memory access", async () => {
    const f = await fixture();
    f.project("public");
    const result = await f.read("kind=capability&limit=100");
    expect(result.records.length).toBeGreaterThan(0);
    expect(result.records.every((record) => record.kind === "capability")).toBe(
      true,
    );
    expect(result.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capabilityKind: "tool" }),
        expect.objectContaining({ capabilityKind: "theme" }),
      ]),
    );
    for (const account of [null, outsider]) {
      const filtered = await f.read("kind=capability&limit=100", account);
      expect(filtered.query.labels).toEqual(["public-memory"]);
      expect(filtered.records).toEqual([]);
      expect(filtered.capsules).toEqual([]);
    }
    f.assertNoLegacyMemory();
  });

  it("rechecks actual transactional ownership after a stale application authorization read", async () => {
    const f = await fixture();
    f.project("public");
    const head = await f.backend.readHead(f.query);
    const readHead = jest.spyOn(f.backend, "readHead");
    for (const route of ["facts", "delete"] as const) {
      readHead.mockResolvedValueOnce({
        ...head,
        branch: { ...head.branch, ownerAccountId: outsider },
      });
      const response = await f.call(route, {
        account: outsider,
        body: { recordId: "forbidden", text: "stale permission" },
        recordId: "forbidden",
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "forbidden" });
    }
    expect(f.putMemory).toHaveBeenCalledTimes(1);
    expect(f.deleteMemory).toHaveBeenCalledTimes(1);
    expect((await f.read("kind=fact")).records).toEqual([]);
    f.assertNoLegacyMemory();
  });

  it.each(["scope", "head", "record"] as const)(
    "rejects a selected query result with corrupt %s without leaking it or falling back",
    async (part) => {
      const f = await fixture();
      await f.writeFact({ recordId: "stored", text: "sensitive result" });
      const result = await f.backend.queryNullMem({
        ...f.query,
        kind: "fact",
        limit: 20,
      });
      if (part === "scope") result.target.rootDropId = "wrong-root";
      if (part === "head") result.head.branch.headSnapshotId += 1;
      if (part === "record") result.records[0].branchId = "wrong-branch";
      f.queryMemory.mockResolvedValueOnce(result);
      const response = await f.call("query", { search: "kind=fact" });
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(JSON.parse(body)).toMatchObject({ code: "state_corrupt" });
      expect(body).not.toContain("sensitive result");
      f.assertNoLegacyMemory();
    },
  );

  it("resolves short aliases read-only and preserves canonical storage scope", async () => {
    const f = await fixture();
    f.blobs.seed(createRemoteAliasKey("LmRa01"), rootDropId, "text/plain");
    const created = await f.call("facts", {
      rootId: "LmRa01",
      body: { text: "alias", recordId: "aliased" },
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      ...f.target,
      record: { ...f.target, recordId: "aliased" },
    });
    const read = await f.call("query", {
      rootId: "LmRa01",
      search: "kind=fact",
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      ...f.target,
      records: [expect.objectContaining({ recordId: "aliased" })],
    });
    f.assertNoLegacyMemory();
  });

  it("retains unsupported-capability authentication ordering and never falls back on selected errors", async () => {
    const f = await fixture();
    f.queryMemory.mockRejectedValueOnce(
      new BranchStateError("state_unavailable"),
    );
    f.putMemory.mockRejectedValueOnce(
      new BranchStateError("state_unavailable"),
    );
    f.deleteMemory.mockRejectedValueOnce(
      new BranchStateError("state_unavailable"),
    );
    for (const route of ["query", "facts", "delete"] as const) {
      const response = await f.call(route, { body: { text: "failed" } });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: "state_unavailable",
      });
    }
    delete f.selection.nullmem;
    expect((await f.call("query", { account: null })).status).toBe(501);
    for (const route of ["facts", "procedures", "delete"] as const) {
      expect((await f.call(route, { account: null })).status).toBe(401);
      const response = await f.call(route);
      expect(response.status).toBe(501);
      expect(await response.json()).toMatchObject({
        code: "capability_unsupported",
      });
    }
    expect(f.queryMemory).toHaveBeenCalledTimes(1);
    expect(f.putMemory).toHaveBeenCalledTimes(1);
    expect(f.deleteMemory).toHaveBeenCalledTimes(1);
    f.assertNoLegacyMemory();
  });
});

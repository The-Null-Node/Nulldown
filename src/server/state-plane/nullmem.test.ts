import { describe, expect, it } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureNullMemPut,
  queryNullMemRecords,
  type BranchNullMemPutCommand,
  type BranchNullMemQueryResult,
} from "../../../shared/drop/branch-nullmem";
import type {
  NullMemFactRecord,
  NullMemProcedureRecord,
} from "../../../shared/nullmem/records";
import { MemoryBranchCommitStatePlane } from "./memory-commits";
import { SqliteBranchCommitStatePlane } from "./sqlite-commits";
import { LocalBranchSqlite } from "./local-sqlite";
import { observeBranchSql, type BranchSqlObservation } from "./sqlite-port";
import {
  contractSeed,
  initialQuery,
  contractEvent,
} from "./testing/commit-contract";
import {
  RpcBranchCommitStatePlane,
  branchStateRpcResult,
  type BranchStateRpcStub,
} from "../../../packages/nulldown-state-plane/src/shard-router";

const query = () => ({ ...initialQuery(), limit: 100 });
const fact = (
  recordId = "record",
  extra: Partial<NullMemFactRecord> = {},
): NullMemFactRecord => ({
  version: 1,
  kind: "fact",
  recordId,
  ...initialQuery().target,
  createdAt: -0.5,
  text: "alpha beta",
  ...extra,
});
const procedure = (
  recordId = "record",
  extra: Partial<NullMemProcedureRecord> = {},
): NullMemProcedureRecord => ({
  version: 1,
  kind: "procedure",
  recordId,
  ...initialQuery().target,
  createdAt: 1,
  goal: "alpha beta",
  summary: "procedure",
  steps: [],
  outcome: "success",
  ...extra,
});
const put = (
  record: BranchNullMemPutCommand["record"] = fact(),
): BranchNullMemPutCommand => ({
  ...initialQuery(),
  actorAccountId: "fixture-owner",
  record,
});
const deletion = (recordId = "record") => ({
  ...initialQuery(),
  actorAccountId: "fixture-owner",
  recordId,
});

for (const backend of ["memory", "sqlite"] as const) {
  describe(`NullMem ${backend}`, () => {
    const open = async (now?: () => number, seeds = [contractSeed()]) => {
      const sql = backend === "sqlite" ? new LocalBranchSqlite() : undefined;
      let clock = 1000;
      now ??= () => clock++;
      const plane = sql
        ? await SqliteBranchCommitStatePlane.create(sql, seeds, {
            now,
          })
        : await MemoryBranchCommitStatePlane.create(seeds, now);
      return { plane, sql, close: () => sql?.close() };
    };

    it("upserts mutable IDs, preserves metadata, deletes all kinds, and accepts absent deletes and recreation", async () => {
      const { plane, close } = await open();
      try {
        const metadata = {
          actorAccountId: "caller-value",
          nested: { literal: "\ud800" },
        };
        const first = await plane.putNullMem(put(fact("record", { metadata })));
        const second = await plane.putNullMem(
          put(fact("record", { text: "replacement", metadata })),
        );
        expect(second.record.createdAt).toBeGreaterThan(first.record.createdAt);
        expect(second.record.metadata).toEqual(metadata);
        await plane.putNullMem(put(procedure()));
        expect((await plane.queryNullMem(query())).records).toHaveLength(2);
        expect((await plane.deleteNullMem(deletion())).memoryRevision).toBe(4);
        expect((await plane.queryNullMem(query())).records).toEqual([]);
        expect((await plane.deleteNullMem(deletion())).memoryRevision).toBe(5);
        const recreated = await plane.putNullMem(put());
        expect(recreated.memoryRevision).toBe(6);
        const replay = await plane.putNullMem(put());
        expect(replay.memoryRevision).toBe(7);
        expect(replay.record.createdAt).toBeGreaterThan(
          recreated.record.createdAt,
        );
        expect((await plane.queryNullMem(query())).records).toEqual([
          replay.record,
        ]);
        expect(
          plane
            .inspectNullMemOutbox(initialQuery())
            .map((entry) => entry.result.memoryRevision),
        ).toEqual([1, 2, 3, 4, 5, 6, 7]);
      } finally {
        close();
      }
    });

    it("filters AND tokens/labels and exact procedures before the result limit beyond 501 nonmatches", async () => {
      const { plane, close } = await open();
      try {
        for (let index = 0; index < 501; index++)
          await plane.putNullMem(
            put(
              procedure(`noise-${index}`, {
                goal: "noise",
                priority: 100,
                labels: ["public-memory"],
              }),
            ),
          );
        const selected = await plane.putNullMem(
          put(
            procedure("needle", {
              priority: -0.25,
              labels: ["public-memory", "exact"],
            }),
          ),
        );
        expect(
          (
            await plane.queryNullMem({
              ...query(),
              q: "ALPHA beta",
              labels: ["public-memory", "exact"],
              limit: 1,
            })
          ).records,
        ).toEqual([selected.record]);
        expect(
          (
            await plane.queryNullMem({
              ...query(),
              procedureId: "needle",
              limit: 1,
            })
          ).records,
        ).toEqual([selected.record]);
        expect(
          (
            await plane.queryNullMem({
              ...query(),
              q: "alpha missing",
              limit: 1,
            })
          ).records,
        ).toEqual([]);
        expect(
          (
            await plane.queryNullMem({
              ...query(),
              labels: ["exact", "missing"],
              limit: 1,
            })
          ).records,
        ).toEqual([]);
        expect((await plane.queryNullMem(query())).records).toHaveLength(100);
      } finally {
        close();
      }
    }, 600_000);

    it("ranks fractional priorities, JSON creation times and locale ties stably", async () => {
      let now = 1000;
      const { plane, close } = await open(() => now);
      try {
        await plane.putNullMem(put(fact("z", { priority: 0.5 })));
        await plane.putNullMem(put(fact("a", { priority: 0.5 })));
        await plane.putNullMem(put(procedure("a", { priority: 0.5 })));
        await plane.putNullMem(put(fact("top", { priority: 0.75 })));
        expect(
          (await plane.queryNullMem(query())).records.map((record) => [
            record.kind,
            record.recordId,
          ]),
        ).toEqual([
          ["fact", "top"],
          ["fact", "a"],
          ["procedure", "a"],
          ["fact", "z"],
        ]);
        now++;
        await plane.putNullMem(put(fact("z", { priority: 0.5 })));
        expect(
          (await plane.queryNullMem(query())).records.map(
            (record) => record.recordId,
          ),
        ).toEqual(["top", "z", "a", "a"]);
      } finally {
        close();
      }
    });

    it("preserves public lexical-score rounding before bounded top-N selection", async () => {
      const { plane, close } = await open();
      try {
        const older = await plane.putNullMem(
          put(fact("older", { text: "needle", priority: 1e-20 })),
        );
        const newer = await plane.putNullMem(
          put(fact("newer", { text: "needle", priority: 0 })),
        );
        expect(newer.record.createdAt).toBeGreaterThan(older.record.createdAt);
        expect(
          (await plane.queryNullMem({ ...query(), limit: 1 })).records,
        ).toEqual([older.record]);
        expect(
          (await plane.queryNullMem({ ...query(), q: "needle", limit: 1 }))
            .records,
        ).toEqual([newer.record]);
      } finally {
        close();
      }
    });

    it("captures snapshot zero/current content changes without source hash gates and isolates returned objects", async () => {
      const { plane, close } = await open();
      try {
        const empty = await plane.queryNullMem(query());
        expect(empty.memoryRevision).toBe(0);
        expect(empty.head.version.snapshotId).toBe(0);
        const first = await plane.putNullMem(put());
        const appending = plane.appendBatch({
          ...initialQuery(),
          events: [contractEvent("edit", "changed", -1)],
        });
        const concurrent = await plane.putNullMem(put(fact("during-append")));
        expect(concurrent.head.version.snapshotId).toBe(0);
        await appending;
        await plane.deleteNullMem(deletion("during-append"));
        const next = await plane.putNullMem(put());
        const read = await plane.queryNullMem(query());
        expect(read.head.version.snapshotId).toBe(1);
        expect(read.head.version.sourceContentHash).not.toBe(
          first.head.version.sourceContentHash,
        );
        expect(read.records).toEqual([next.record]);
        read.records[0].recordId = "forged";
        read.head.branch.ownerAccountId = "forged";
        expect((await plane.queryNullMem(query())).records[0].recordId).toBe(
          "record",
        );
        expect(
          plane.inspectNullMemOutbox(initialQuery())[0].result.head.version
            .snapshotId,
        ).toBe(0);
      } finally {
        close();
      }
    });

    it("serializes concurrent writes as fresh revisions with one current record and preserves UTF-16/extensions", async () => {
      const { plane, close } = await open();
      try {
        const input = put(
          fact("\ud800:%2F", {
            title: undefined,
            metadata: {
              actorAccountId: "untouched",
              literal: "\udfff",
              optional: undefined,
            } as never,
          }),
        );
        Object.defineProperty(input.record, "__proto__", {
          enumerable: true,
          value: { preserved: "\ud800" },
        });
        Object.assign(input.record, {
          extension: { nested: [undefined, "\ud800", "�"] },
        });
        const results = await Promise.all(
          Array.from({ length: 8 }, () => plane.putNullMem(input)),
        );
        expect(results.map((result) => result.memoryRevision)).toEqual([
          1, 2, 3, 4, 5, 6, 7, 8,
        ]);
        expect((await plane.queryNullMem(query())).records).toEqual([
          results[7].record,
        ]);
        expect(JSON.parse(JSON.stringify(results[0].record)).__proto__).toEqual(
          { preserved: "\ud800" },
        );
        expect(
          JSON.parse(JSON.stringify(results[0].record)).extension.nested,
        ).toEqual([null, "\ud800", "�"]);
        for (const id of ["�:%2F", "", "a:b", "a%3Ab"])
          await plane.putNullMem(put(fact(id)));
        expect((await plane.queryNullMem(query())).records).toHaveLength(5);
        await plane.deleteNullMem(deletion("\ud800:%2F"));
        expect(
          (await plane.queryNullMem(query())).records.map(
            (record) => record.recordId,
          ),
        ).toContain("�:%2F");
      } finally {
        close();
      }
    });

    it("keeps exact root/branch tuples isolated, including UTF-16, and adds no status gate", async () => {
      const seeds = [
        contractSeed("a:b"),
        contractSeed("b"),
        contractSeed("\ud800"),
        contractSeed("�"),
      ];
      seeds[1].branch.rootDropId = "OracleRoot001:a";
      seeds[0].branch.status = "archived";
      const { plane, close } = await open(undefined, seeds);
      try {
        for (const [index, seed] of seeds.entries()) {
          const scope = initialQuery(seed);
          await plane.putNullMem({
            ...scope,
            actorAccountId: "fixture-owner",
            record: {
              ...fact("same"),
              ...scope.target,
              text: `scope-${index}`,
            },
          });
        }
        for (const [index, seed] of seeds.entries()) {
          const scope = initialQuery(seed);
          const result = await plane.queryNullMem({ ...scope, limit: 100 });
          expect(result.records).toHaveLength(1);
          expect(result.records[0]).toMatchObject({ text: `scope-${index}` });
          expect(result.memoryRevision).toBe(1);
        }
      } finally {
        close();
      }
    });

    it("rejects stale placement, forged actor, invalid filters/scopes and bad clocks without mutation", async () => {
      const { plane, close } = await open(() => -1);
      try {
        await expect(
          plane.putNullMem({ ...put(), actorAccountId: "forged" }),
        ).rejects.toMatchObject({ code: "forbidden" });
        await expect(
          plane.deleteNullMem({ ...deletion(), actorAccountId: "forged" }),
        ).rejects.toMatchObject({ code: "forbidden" });
        await expect(
          plane.putNullMem({
            ...put(),
            placement: { routingVersion: 1, generation: 8 },
          }),
        ).rejects.toMatchObject({ code: "routing_generation_mismatch" });
        await expect(
          plane.putNullMem(put(fact("id", { branchId: "other" }))),
        ).rejects.toMatchObject({ code: "invalid_command" });
        for (const filters of [
          { limit: 0 },
          { limit: 101 },
          { limit: 1.1 },
          { q: [] },
          { labels: "a" },
          { labels: Array(2) },
          { kind: "unknown" },
          { procedureId: 1 },
        ])
          await expect(
            plane.queryNullMem({ ...query(), ...filters } as never),
          ).rejects.toMatchObject({ code: "invalid_command" });
        await expect(plane.putNullMem(put())).rejects.toMatchObject({
          code: "invalid_command",
        });
        await expect(plane.deleteNullMem(deletion())).rejects.toMatchObject({
          code: "invalid_command",
        });
        expect((await plane.queryNullMem(query())).memoryRevision).toBe(0);
      } finally {
        close();
      }
    });
  });
}

describe("NullMem persistence and RPC", () => {
  it("checks the actor against the current validated SQL head inside the mutation transaction", async () => {
    const sql = new LocalBranchSqlite();
    let armed = false;
    const port = observeBranchSql(sql, (row) => {
      if (armed && row.operation === "transaction" && row.phase === "before") {
        armed = false;
        sql.execute(
          "UPDATE branch_heads SET head_json = json_set(head_json, '$.branch.ownerAccountId', 'new-owner', '$.branch.writerAccountId', 'new-writer')",
        );
      }
    });
    try {
      const plane = await SqliteBranchCommitStatePlane.create(port, [
        contractSeed(),
      ]);
      const previouslyAuthorized = put();
      armed = true;
      await expect(
        plane.putNullMem(previouslyAuthorized),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect((await plane.queryNullMem(query())).memoryRevision).toBe(0);
      const accepted = await plane.putNullMem({
        ...put(),
        actorAccountId: "new-writer",
      });
      expect(accepted.head.branch.writerAccountId).toBe("new-writer");
      await expect(plane.deleteNullMem(deletion())).rejects.toMatchObject({
        code: "forbidden",
      });
    } finally {
      sql.close();
    }
  });

  it("survives reopening and models lost acknowledgements as new writes/deletes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nullmem-contract-"));
    let sql = new LocalBranchSqlite(join(directory, "state.sqlite"));
    try {
      let plane = await SqliteBranchCommitStatePlane.create(
        sql,
        [contractSeed()],
        { now: () => 1000 },
      );
      await plane.putNullMem(put()); // response deliberately discarded
      sql.close();
      sql = new LocalBranchSqlite(join(directory, "state.sqlite"));
      plane = new SqliteBranchCommitStatePlane(sql, { now: () => 2000 });
      const retried = await plane.putNullMem(put());
      expect(retried.memoryRevision).toBe(2);
      expect(retried.record.createdAt).toBe(2000);
      await plane.deleteNullMem(deletion());
      await plane.putNullMem(put());
      await plane.deleteNullMem(deletion()); // fresh retry deletes recreation, as public semantics specify
      expect((await plane.queryNullMem(query())).records).toEqual([]);
      expect(plane.inspectNullMemOutbox(initialQuery())).toHaveLength(5);
    } finally {
      sql.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back put and delete at both sides of every publication statement", async () => {
    for (const action of ["put", "delete"] as const) {
      const sql = new LocalBranchSqlite();
      let armed = false,
        cut = -1,
        index = 0;
      const trace: BranchSqlObservation[] = [];
      const port = observeBranchSql(sql, (row) => {
        if (!armed || row.operation !== "execute") return;
        trace.push(row);
        if (index++ === cut) throw Error("publication cut");
      });
      try {
        const plane = await SqliteBranchCommitStatePlane.create(
          port,
          [contractSeed()],
          { now: () => 1000 },
        );
        await plane.putNullMem(put());
        await plane.putNullMem(put(procedure()));
        const before = await plane.queryNullMem(query());
        const outbox = plane.inspectNullMemOutbox(initialQuery());
        const cuts = action === "put" ? 6 : 8;
        for (cut = 0; cut < cuts; cut++) {
          armed = true;
          index = 0;
          await expect(
            action === "put"
              ? plane.putNullMem(put(fact("record", { text: "replacement" })))
              : plane.deleteNullMem(deletion()),
          ).rejects.toMatchObject({ code: "state_unavailable" });
          armed = false;
          expect(await plane.queryNullMem(query())).toEqual(before);
          expect(plane.inspectNullMemOutbox(initialQuery())).toEqual(outbox);
        }
        expect(
          trace.some(
            (row) =>
              row.sql?.includes("branch_nullmem_outbox") &&
              row.phase === "after",
          ),
        ).toBe(true);
      } finally {
        sql.close();
      }
    }
  });

  it("fails closed on independently corrupted records, revision, outbox identity/intent/head and missing rows", async () => {
    const mutations = [
      "UPDATE branch_nullmem_records SET record_json = '{}'",
      'UPDATE branch_nullmem_records SET identity = \'["fact","wrong"]\'',
      "DELETE FROM branch_nullmem_records",
      "UPDATE branch_nullmem_heads SET memory_revision = 2",
      "DELETE FROM branch_nullmem_heads",
      "DELETE FROM branch_nullmem_outbox",
      "UPDATE branch_nullmem_outbox SET outbox_id = 'wrong'",
      "UPDATE branch_nullmem_outbox SET outbox_json = json_set(outbox_json, '$.intent', 'wrong')",
      "UPDATE branch_nullmem_outbox SET outbox_json = json_set(outbox_json, '$.result.head.version.sourceContentHash', 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')",
      "UPDATE branch_nullmem_outbox SET outbox_json = json_set(outbox_json, '$.actorAccountId', 'forged')",
    ];
    for (const mutation of mutations) {
      const sql = new LocalBranchSqlite();
      try {
        const plane = await SqliteBranchCommitStatePlane.create(sql, [
          contractSeed(),
        ]);
        await plane.putNullMem(put());
        sql.execute(mutation);
        await expect(plane.queryNullMem(query())).rejects.toMatchObject({
          code: "state_corrupt",
        });
        await expect(plane.putNullMem(put())).rejects.toMatchObject({
          code: "state_corrupt",
        });
        await expect(plane.deleteNullMem(deletion())).rejects.toMatchObject({
          code: "state_corrupt",
        });
      } finally {
        sql.close();
      }
    }
  });

  it("captures inputs before routing yields and rejects altered RPC metadata/identity/head and invalid query pages", async () => {
    const plane = await MemoryBranchCommitStatePlane.create(
      [contractSeed()],
      () => 1000,
    );
    let alter: (value: unknown) => unknown = (value) => value;
    const stub = {
      queryNullMem: (input: Parameters<typeof plane.queryNullMem>[0]) =>
        branchStateRpcResult(async () =>
          alter(await plane.queryNullMem(input)),
        ),
      putNullMem: (input: BranchNullMemPutCommand) =>
        branchStateRpcResult(async () => alter(await plane.putNullMem(input))),
      deleteNullMem: (input: Parameters<typeof plane.deleteNullMem>[0]) =>
        branchStateRpcResult(async () =>
          alter(await plane.deleteNullMem(input)),
        ),
    } as BranchStateRpcStub;
    const rpc = new RpcBranchCommitStatePlane(() => stub);
    const input = put(fact("id", { metadata: { actorAccountId: "preserve" } }));
    const pending = rpc.putNullMem(input);
    input.record.recordId = "changed-after-call";
    expect((await pending).record.recordId).toBe("id");
    for (const field of ["record", "head", "revision", "scope"] as const) {
      alter = (value) => {
        const result = structuredClone(value) as Awaited<
          ReturnType<typeof plane.putNullMem>
        >;
        if (field === "record")
          result.record.metadata = { actorAccountId: "overwritten" };
        if (field === "head") result.head.version.snapshotId = 1;
        if (field === "revision") result.memoryRevision = 0;
        if (field === "scope") result.target.branchId = "different";
        return result;
      };
      await expect(rpc.putNullMem(put())).rejects.toMatchObject({
        code: "state_corrupt",
      });
    }
    alter = (value) => {
      const result = value as BranchNullMemQueryResult;
      result.records = [...result.records, ...result.records];
      return result;
    };
    await expect(rpc.queryNullMem(query())).rejects.toMatchObject({
      code: "state_corrupt",
    });
    alter = (value) => ({ ...(value as object), recordId: "wrong" });
    await expect(rpc.deleteNullMem(deletion())).rejects.toMatchObject({
      code: "state_corrupt",
    });
    const missing = new RpcBranchCommitStatePlane(
      () => ({}) as BranchStateRpcStub,
    );
    await expect(missing.queryNullMem(query())).rejects.toMatchObject({
      code: "capability_unsupported",
    });
  });

  it("rejects non-JSON extensions and preserves stable exact ties across mixed catalogs", () => {
    for (const extension of [Number.NaN, () => 1, new Date(), 1n])
      expect(() =>
        captureNullMemPut(put(Object.assign(fact(), { extension }))),
      ).toThrow();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      captureNullMemPut(put(Object.assign(fact(), { circular }))),
    ).toThrow();
    const records = [
      fact("same", { createdAt: 1 }),
      procedure("same", { createdAt: 1 }),
    ];
    expect(queryNullMemRecords(records, { limit: 1 })).toEqual([records[0]]);
    expect(
      queryNullMemRecords(records, { limit: 1, procedureId: "same" }),
    ).toEqual([records[1]]);
  });
});

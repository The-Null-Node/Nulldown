import { describe, it, expect } from "@jest/globals";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BranchCommitOutboxRecord,
  BranchHeadQuery,
} from "../../../shared/drop/branch-state";
import { MemoryBranchCommitStatePlane } from "./memory-commits";
import { LocalBranchSqlite } from "./local-sqlite";
import { SqliteBranchCommitStatePlane } from "./sqlite-commits";
import { ExactContentCache } from "./exact-content-cache";
import type { BranchSqlPort, BranchSqlValue } from "./sqlite-port";
import {
  commitContractScenarios,
  contractHistory,
  contractSeed,
  initialQuery,
  referenceCommand,
  referenceVersion,
  rejectsCode,
  assertRecords,
  assertUtf16,
  losslessFixtures,
  verifyLosslessHistory,
  referenceSourceHash,
  type CommitContractFactory,
} from "./testing/commit-contract";

const outbox = (
  sql: BranchSqlPort,
  query: BranchHeadQuery,
): BranchCommitOutboxRecord[] =>
  sql
    .rows<{ outbox_json: string }>(
      "SELECT outbox_json FROM branch_outbox WHERE root_drop_id = ? AND branch_id = ? ORDER BY event_id",
      JSON.stringify(query.target.rootDropId),
      JSON.stringify(query.target.branchId),
    )
    .map((row) => JSON.parse(row.outbox_json) as BranchCommitOutboxRecord);

const factories: { name: string; create: CommitContractFactory }[] = [
  {
    name: "memory model under test",
    create: async (seed) => {
      const plane = await MemoryBranchCommitStatePlane.create(
        [seed],
        () => 2000,
      );
      return {
        plane,
        inspectOutbox: async (query) => plane.inspectOutbox(query),
        close: async () => {},
      };
    },
  },
  {
    name: "native node:sqlite",
    create: async (seed) => {
      const sql = new LocalBranchSqlite();
      const plane = await SqliteBranchCommitStatePlane.create(sql, [seed], {
        now: () => 2000,
      });
      return {
        plane,
        inspectOutbox: async (query) => outbox(sql, query),
        close: async () => sql.close(),
      };
    },
  },
];

for (const factory of factories)
  describe(factory.name, () => {
    for (const scenario of commitContractScenarios)
      it(scenario.name, async () => {
        const backend = await factory.create(contractSeed());
        try {
          await scenario.run(backend);
        } finally {
          await backend.close();
        }
      });
  });

interface Observation {
  operation: "rows" | "execute" | "transaction";
  phase: "before" | "after";
  transaction: number;
  sql?: string;
}

describe("lossless UTF-16 content and SQL identity (S1)", () => {
  for (const backend of ["memory", "node:sqlite"] as const) {
    it(`${backend}: lone seeds, half-emoji deletes, distinct scopes/event IDs, immutable retries and reopen`, async () => {
      // These distinct strings intentionally collide under the unchanged UTF-8 hash.
      assert.equal(
        referenceSourceHash("\ud800"),
        referenceSourceHash("\ufffd"),
      );
      const fixtures = losslessFixtures();
      const directory = mkdtempSync(join(tmpdir(), "state-plane-lossless-"));
      const filename = join(directory, "state.sqlite");
      let sql: LocalBranchSqlite | undefined;
      const cache = new ExactContentCache({ maxEntries: 1, maxBytes: 16_384 });
      try {
        if (backend === "node:sqlite") sql = new LocalBranchSqlite(filename);
        const plane = sql
          ? await SqliteBranchCommitStatePlane.create(
              sql,
              fixtures.map((f) => f.seed),
              { cache },
            )
          : await MemoryBranchCommitStatePlane.create(
              fixtures.map((f) => f.seed),
            );
        for (const fixture of fixtures) {
          for (let read = 0; read < 2; read++)
            assertUtf16(
              (
                await plane.readContent({
                  ...fixture.query,
                  version: referenceVersion(0, fixture.seed.content),
                })
              ).content,
              fixture.seed.content,
            );
          for (const row of fixture.history)
            assertRecords(await plane.append(row.command), {
              status: "accepted",
              receipt: row.receipt,
            });
        }
        for (const fixture of fixtures) {
          await verifyLosslessHistory(plane, fixture);
          if (!sql) continue;
          const zero = {
            ...fixture.query,
            version: referenceVersion(0, fixture.seed.content),
          };
          const one = {
            ...fixture.query,
            version: fixture.history[0].receipt.version,
          };
          await plane.readContent(zero);
          await plane.readContent(one);
          assert.equal(
            cache.get(zero),
            undefined,
            "one-entry LRU really evicted snapshot zero",
          );
          assertUtf16(
            (await plane.readContent(zero)).content,
            fixture.seed.content,
          );
          const scope = [
            JSON.stringify(fixture.query.target.rootDropId),
            JSON.stringify(fixture.query.target.branchId),
          ];
          for (const [snapshotId, content] of [
            fixture.seed.content,
            ...fixture.history.map((row) => row.content),
          ].entries()) {
            const stored = sql.rows<{
              root_drop_id: string;
              branch_id: string;
              content: string;
            }>(
              "SELECT root_drop_id, branch_id, content FROM branch_snapshots WHERE root_drop_id=? AND branch_id=? AND snapshot_id=?",
              ...scope,
              snapshotId,
            );
            assertRecords(stored, [
              {
                root_drop_id: scope[0],
                branch_id: scope[1],
                content: JSON.stringify(content),
              },
            ]);
          }
          for (const row of fixture.history) {
            for (const table of [
              "branch_events",
              "branch_receipts",
              "branch_outbox",
            ]) {
              const stored = sql.rows<{ event_id: string }>(
                `SELECT event_id FROM ${table} WHERE root_drop_id=? AND branch_id=? AND event_id=?`,
                ...scope,
                JSON.stringify(row.command.event.eventId),
              );
              assertRecords(stored, [
                { event_id: JSON.stringify(row.command.event.eventId) },
              ]);
            }
          }
          assert.equal(
            outbox(sql, fixture.query).length,
            fixture.history.length,
          );
        }
        if (sql) {
          sql.close();
          sql = new LocalBranchSqlite(filename);
          const reopened = new SqliteBranchCommitStatePlane(sql, {
            cache: new ExactContentCache({ maxEntries: 1, maxBytes: 16_384 }),
          });
          for (const fixture of fixtures)
            await verifyLosslessHistory(reopened, fixture);
        }
      } finally {
        sql?.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  it("content decode rejects malformed/non-string JSON; valid encoded wrong content fails hash validation", async () => {
    const sql = new LocalBranchSqlite();
    try {
      const seed = { ...contractSeed(), content: "😀" };
      await SqliteBranchCommitStatePlane.create(sql, [seed]);
      for (const encoded of [
        "not-json",
        "null",
        "42",
        "{}",
        "[]",
        JSON.stringify("xx"),
      ]) {
        sql.execute("UPDATE branch_snapshots SET content=?", encoded);
        await rejectsCode(
          () =>
            new SqliteBranchCommitStatePlane(sql).readContent({
              ...initialQuery(seed),
              version: referenceVersion(0, seed.content),
            }),
          "state_corrupt",
        );
      }
    } finally {
      sql.close();
    }
  });
});

function instrument(
  raw: BranchSqlPort,
  observe: (event: Observation) => void,
): BranchSqlPort {
  let transaction = 0;
  return {
    rows<T extends Record<string, unknown>>(
      sql: string,
      ...bindings: BranchSqlValue[]
    ): T[] {
      observe({ operation: "rows", phase: "before", transaction, sql });
      const result = raw.rows<T>(sql, ...bindings);
      observe({ operation: "rows", phase: "after", transaction, sql });
      return result;
    },
    execute(sql, ...bindings) {
      observe({ operation: "execute", phase: "before", transaction, sql });
      raw.execute(sql, ...bindings);
      observe({ operation: "execute", phase: "after", transaction, sql });
    },
    transaction<T>(body: () => T): T {
      transaction++;
      observe({ operation: "transaction", phase: "before", transaction });
      const result = raw.transaction(body);
      observe({ operation: "transaction", phase: "after", transaction });
      return result;
    },
  };
}

describe("SQLite atomic publication gates (legacy gaps must remain red)", () => {
  it("rolls back at every statement before/after, including outbox; competitors can reuse the failed sequence", async () => {
    const trace: Observation[] = [];
    const sampleRaw = new LocalBranchSqlite();
    try {
      const sample = await SqliteBranchCommitStatePlane.create(
        instrument(sampleRaw, (e) => trace.push(e)),
        [contractSeed()],
      );
      trace.length = 0;
      await sample.append(contractHistory(1)[0].command);
    } finally {
      sampleRaw.close();
    }
    const cuts = trace.filter((e) => e.operation !== "transaction");
    expect(cuts.some((e) => e.sql?.includes("branch_outbox"))).toBe(true);
    expect(cuts.length).toBeGreaterThanOrEqual(16);
    for (const [cut, expectedCut] of cuts.entries()) {
      const raw = new LocalBranchSqlite();
      let armed = false,
        index = 0,
        fired = false;
      try {
        const sql = instrument(raw, (e) => {
          if (!armed || e.operation === "transaction") return;
          if (index++ === cut) {
            fired = true;
            assert.equal(e.sql, expectedCut.sql);
            assert.equal(e.phase, expectedCut.phase);
            throw Error("fixture synchronous SQL cut");
          }
        });
        const plane = await SqliteBranchCommitStatePlane.create(sql, [
          contractSeed(),
        ]);
        const [entry] = contractHistory(1);
        armed = true;
        await rejectsCode(
          () => plane.append(entry.command),
          "state_unavailable",
        );
        armed = false;
        assert.ok(fired);
        // A fresh adapter reads actual retained SQLite, not an in-memory re-instantiation as durability proof.
        const reopened = new SqliteBranchCommitStatePlane(raw);
        assertRecords(
          (await reopened.readHead(initialQuery())).version,
          referenceVersion(0, ""),
        );
        await rejectsCode(
          () =>
            reopened.readContent({
              ...initialQuery(),
              version: entry.receipt.version,
            }),
          "snapshot_not_found",
        );
        for (const table of [
          "branch_events",
          "branch_receipts",
          "branch_outbox",
        ])
          assert.equal(
            raw.rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0].n,
            0,
          );
        assert.equal(
          raw.rows<{ n: number }>(
            "SELECT COUNT(*) AS n FROM branch_snapshots",
          )[0].n,
          1,
        );
        // Neither partial events nor orphan receipts reserve the failed command's sequence.
        const competitor = referenceCommand(
          initialQuery(),
          entry.command.expected,
          { ...entry.command.event, eventId: "competitor" },
        );
        assert.equal((await reopened.append(competitor)).status, "accepted");
        await rejectsCode(
          () => reopened.append(entry.command),
          "diff_predecessor_mismatch",
        );
      } finally {
        raw.close();
      }
    }
  });

  it("postcommit lost response is state_unavailable/same-command and retains receipt and one outbox", async () => {
    const raw = new LocalBranchSqlite();
    let armed = false,
      commits = 0;
    try {
      const sql = instrument(raw, (e) => {
        if (
          armed &&
          e.operation === "transaction" &&
          e.phase === "after" &&
          ++commits === 2
        )
          throw Error("fixture response lost after commit");
      });
      const plane = await SqliteBranchCommitStatePlane.create(sql, [
        contractSeed(),
      ]);
      const [entry] = contractHistory(1);
      armed = true;
      await assert.rejects(
        () => plane.append(entry.command),
        (error: unknown) => {
          assert.ok(
            error !== null &&
              typeof error === "object" &&
              "toRecord" in error &&
              typeof error.toRecord === "function",
          );
          assertRecords(error.toRecord(), {
            code: "state_unavailable",
            status: 503,
            outcome: "unknown",
            retry: "same-command",
          });
          return true;
        },
      );
      armed = false;
      const fresh = new SqliteBranchCommitStatePlane(raw);
      assertRecords(await fresh.append(entry.command), {
        status: "duplicate",
        receipt: entry.receipt,
      });
      assert.equal(outbox(raw, initialQuery()).length, 1);
    } finally {
      raw.close();
    }
  });

  it("rejects a Promise transaction callback and rolls its SQL back", () => {
    const raw = new LocalBranchSqlite();
    try {
      raw.execute("CREATE TABLE fixture_atomic (value INTEGER)");
      expect(() =>
        raw.transaction(() => {
          raw.execute("INSERT INTO fixture_atomic VALUES (1)");
          return Promise.resolve(1);
        }),
      ).toThrow("synchronous");
      expect(raw.rows("SELECT * FROM fixture_atomic")).toEqual([]);
    } finally {
      raw.close();
    }
  });

  it("corrupt interior range and wrong durable content hash fail closed", async () => {
    const raw = new LocalBranchSqlite();
    try {
      const plane = await SqliteBranchCommitStatePlane.create(raw, [
        contractSeed(),
      ]);
      const history = contractHistory(3);
      for (const entry of history) await plane.append(entry.command);
      raw.execute("DELETE FROM branch_events WHERE event_seq = 1");
      await rejectsCode(
        () =>
          plane.readEvents({
            ...initialQuery(),
            version: history[2].receipt.version,
            startSeq: 0,
            endSeq: 2,
          }),
        "state_corrupt",
      );
      const text = history[2].content;
      raw.execute(
        "UPDATE branch_snapshots SET content = ? WHERE snapshot_id = 3",
        JSON.stringify("x".repeat(text.length)),
      );
      await rejectsCode(
        () =>
          new SqliteBranchCommitStatePlane(raw).readContent({
            ...initialQuery(),
            version: history[2].receipt.version,
          }),
        "state_corrupt",
      );
    } finally {
      raw.close();
    }
  });

  it("generation is rechecked after preparation and on hot cache reads", async () => {
    const raw = new LocalBranchSqlite();
    let armed = false,
      reads = 0;
    try {
      const sql = instrument(raw, (e) => {
        if (
          armed &&
          e.operation === "transaction" &&
          e.phase === "after" &&
          ++reads === 1
        ) {
          raw.execute("UPDATE branch_heads SET generation = 8");
        }
      });
      const plane = await SqliteBranchCommitStatePlane.create(sql, [
        contractSeed(),
      ]);
      await plane.readContent({
        ...initialQuery(),
        version: referenceVersion(0, ""),
      });
      armed = true;
      await rejectsCode(
        () => plane.append(contractHistory(1)[0].command),
        "routing_generation_mismatch",
      );
      armed = false;
      await rejectsCode(
        () =>
          plane.readContent({
            ...initialQuery(),
            version: referenceVersion(0, ""),
          }),
        "routing_generation_mismatch",
      );
      assert.equal(outbox(raw, initialQuery()).length, 0);
    } finally {
      raw.close();
    }
  });

  it("head/exact reads have constant SQL counts; range uses one bounded indexed query", async () => {
    const raw = new LocalBranchSqlite(),
      trace: Observation[] = [];
    try {
      const plane = await SqliteBranchCommitStatePlane.create(
        instrument(raw, (e) => trace.push(e)),
        [contractSeed()],
      );
      const history = contractHistory(100);
      const samples: { head: number; hot: number; range: number }[] = [];
      for (const [i, entry] of history.entries()) {
        await plane.append(entry.command);
        if (![1, 10, 24, 25, 100].includes(i + 1)) continue;
        const count = () =>
          trace.filter((e) => e.phase === "before" && e.operation === "rows")
            .length;
        trace.length = 0;
        await plane.readHead(initialQuery());
        const head = count();
        assert.ok(head <= 2);
        await plane.readContent({
          ...initialQuery(),
          version: entry.receipt.version,
        });
        trace.length = 0;
        await plane.readContent({
          ...initialQuery(),
          version: entry.receipt.version,
        });
        const hot = count();
        assert.ok(hot <= 4);
        trace.length = 0;
        await plane.readEvents({
          ...initialQuery(),
          version: entry.receipt.version,
          startSeq: 0,
          endSeq: i,
        });
        const range = count();
        assert.ok(range <= 3);
        const queries = trace.filter(
          (e) =>
            e.phase === "before" &&
            e.operation === "rows" &&
            e.sql?.includes("FROM branch_events"),
        );
        assert.equal(queries.length, 1);
        assert.match(queries[0].sql!, /LIMIT 200/);
        const plan = raw.rows<{ detail: string }>(
          "EXPLAIN QUERY PLAN " + queries[0].sql!,
          JSON.stringify(initialQuery().target.rootDropId),
          JSON.stringify("owner"),
          0,
          i,
        );
        assert.ok(
          plan.some((row) => /SEARCH .*branch_events.*INDEX/i.test(row.detail)),
          JSON.stringify(plan),
        );
        assert.ok(
          plan.every((row) => !/\bSCAN\b/i.test(row.detail)),
          JSON.stringify(plan),
        );
        samples.push({ head, hot, range });
      }
      assert.ok(
        samples.every(
          (sample) => JSON.stringify(sample) === JSON.stringify(samples[0]),
        ),
      );
    } finally {
      raw.close();
    }
  });
});

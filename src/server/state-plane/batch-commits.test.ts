import { describe, it, expect } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BranchAppendCommand,
  type BranchBatchStatePlane,
  type BranchBatchAppendResult,
} from "../../../shared/drop/branch-state";
import type { DropDiffEvent } from "../../../shared/drop/diff";
import { DiffOp } from "../../../shared/nulledit/types";
import {
  MemoryBranchCommitStatePlane,
  type MemoryBranchStateSeed,
} from "./memory-commits";
import { SqliteBranchCommitStatePlane } from "./sqlite-commits";
import { LocalBranchSqlite } from "./local-sqlite";
import type { BranchSqlPort } from "./sqlite-port";
import {
  contractSeed,
  initialQuery,
  referenceSourceHash,
} from "./testing/commit-contract";
import { appendEventsToBranch } from "../../../functions/api/_lib/nulledit/service";
import { resolveBranchForActor } from "../../../functions/api/_lib/branches/lifecycle";
import {
  createSeededBucket,
  rootDropId,
  accountId,
} from "../../../functions/api/_lib/diffs/testing/storage-fixture";
import {
  RpcBranchCommitStatePlane,
  branchStateRpcResult,
} from "../../../packages/nulldown-state-plane/src/shard-router";

const event = (id: string, text = id, followsSeq?: number): DropDiffEvent => ({
  eventId: id,
  seq: 99,
  snapshotId: 99,
  dropId: contractSeed().branch.rootDropId,
  sourceClientId: "writer",
  createdAt: 100,
  ops: [{ type: "insert", start: 1000, end: 1000, text }],
  ...(followsSeq === undefined ? {} : { metadata: { followsSeq } }),
});

const factories = [
  {
    name: "memory",
    create: async (seed: MemoryBranchStateSeed) => ({
      plane: await MemoryBranchCommitStatePlane.create([seed], () => 2000),
      close: () => {},
    }),
  },
  {
    name: "SQLite",
    create: async (seed: MemoryBranchStateSeed) => {
      const sql = new LocalBranchSqlite();
      return {
        plane: await SqliteBranchCommitStatePlane.create(sql, [seed], {
          now: () => 2000,
        }),
        close: () => sql.close(),
      };
    },
  },
];

for (const factory of factories)
  describe(`public envelope semantics: ${factory.name}`, () => {
    const run = async (
      body: (plane: BranchBatchStatePlane) => Promise<void>,
    ) => {
      const backend = await factory.create(contractSeed());
      try {
        await body(backend.plane);
      } finally {
        backend.close();
      }
    };
    it("commits one snapshot for two events, preserves absent predecessors, and keeps individual receipt sequences", () =>
      run(async (plane) => {
        const first = await plane.appendBatch({
          ...initialQuery(),
          events: [event("a"), event("b")],
        });
        expect(first.content).toBe("ab");
        expect(first.snapshot).toMatchObject({
          snapshotId: 1,
          eventIds: ["a", "b"],
          patchStartSeq: 0,
          patchEndSeq: 1,
        });
        expect(first.acknowledgements).toEqual([
          { eventId: "a", seq: 0, snapshotId: 1, status: "accepted" },
          { eventId: "b", seq: 1, snapshotId: 1, status: "accepted" },
        ]);
        const next = await plane.appendBatch({
          ...initialQuery(),
          events: [
            event("b"),
            event("c", "c", 1),
            event("c", "c", 1),
            event("a"),
            event("d", "d", 2),
          ],
        });
        expect(next).toMatchObject({
          content: "abcd",
          deduplicatedCount: 3,
          totalStored: 4,
          snapshot: { snapshotId: 2, eventIds: ["c", "d"] },
        });
        expect(next.acknowledgements).toEqual([
          { eventId: "b", seq: 1, snapshotId: 1, status: "duplicate" },
          { eventId: "c", seq: 2, snapshotId: 2, status: "accepted" },
          { eventId: "a", seq: 0, snapshotId: 1, status: "duplicate" },
          { eventId: "d", seq: 3, snapshotId: 2, status: "accepted" },
        ]);
        const head = await plane.readHead(initialQuery());
        const polled = await plane.readEvents({
          ...initialQuery(),
          version: head.version,
          startSeq: 0,
          endSeq: 3,
        });
        expect(
          polled.map((row) => [
            row.seq,
            row.snapshotId,
            row.metadata?.followsSeq,
          ]),
        ).toEqual([
          [0, 1, undefined],
          [1, 1, undefined],
          [2, 2, 1],
          [3, 2, 2],
        ]);
        const replay = await plane.appendBatch({
          ...initialQuery(),
          events: [event("a"), event("b"), event("a")],
        });
        expect(replay).toMatchObject({
          snapshot: null,
          content: "abcd",
          totalStored: 4,
          deduplicatedCount: 3,
          acceptedEvents: [],
        });
        expect(
          replay.acknowledgements.map((ack) => [ack.seq, ack.snapshotId]),
        ).toEqual([
          [0, 1],
          [1, 1],
        ]);
        expect(
          (
            await plane.readContent({
              ...initialQuery(),
              version: {
                snapshotId: 1,
                eventSeq: 1,
                sourceContentHash: referenceSourceHash("ab"),
              },
            })
          ).content,
        ).toBe("ab");
      }));

    it("empty envelopes and repeated identical input IDs create no extra snapshots or acknowledgements", () =>
      run(async (plane) => {
        expect(
          await plane.appendBatch({ ...initialQuery(), events: [] }),
        ).toMatchObject({
          snapshot: null,
          content: "",
          acceptedEvents: [],
          acknowledgements: [],
          deduplicatedCount: 0,
          totalStored: 0,
        });
        const value = event("a");
        const result = await plane.appendBatch({
          ...initialQuery(),
          events: [value, { ...value, seq: 123, snapshotId: 123 }],
        });
        expect(result).toMatchObject({
          content: "a",
          deduplicatedCount: 1,
          totalStored: 1,
        });
        expect(result.acknowledgements).toHaveLength(1);
        expect(result.acknowledgements[0].status).toBe("accepted");
      }));

    it("rejects stale later predecessors and conflicting later identities with zero published prefix", () =>
      run(async (plane) => {
        for (const events of [
          [event("a", "a", -1), event("b", "b", -1)],
          [event("a"), event("a", "changed")],
        ]) {
          await expect(
            plane.appendBatch({ ...initialQuery(), events }),
          ).rejects.toThrow(
            events[1].eventId === "b"
              ? "diff_predecessor_mismatch"
              : "diff_event_id_reused",
          );
          expect((await plane.readHead(initialQuery())).version).toEqual({
            snapshotId: 0,
            eventSeq: -1,
            sourceContentHash: referenceSourceHash(""),
          });
        }
        await plane.appendBatch({ ...initialQuery(), events: [event("a")] });
        await expect(
          plane.appendBatch({
            ...initialQuery(),
            events: [event("new"), event("a", "changed")],
          }),
        ).rejects.toThrow("diff_event_id_reused");
        expect((await plane.readHead(initialQuery())).version.eventSeq).toBe(0);
      }));

    it("serializes concurrent implicit-predecessor batches and deduplicates concurrent retries", () =>
      run(async (plane) => {
        const results = await Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            plane.appendBatch({
              ...initialQuery(),
              events: [event(`a${i}`), event(`b${i}`)],
            }),
          ),
        );
        expect(
          results.every((result) => result.acceptedEvents.length === 2),
        ).toBe(true);
        const head = await plane.readHead(initialQuery());
        expect(head.version).toMatchObject({ snapshotId: 8, eventSeq: 15 });
        const events = await plane.readEvents({
          ...initialQuery(),
          version: head.version,
          startSeq: 0,
          endSeq: 15,
        });
        for (let i = 0; i < events.length; i += 2) {
          expect(events[i].snapshotId).toBe(events[i + 1].snapshotId);
          expect(events[i + 1].eventId.slice(1)).toBe(
            events[i].eventId.slice(1),
          );
        }
        const retries = await Promise.all(
          Array.from({ length: 8 }, () =>
            plane.appendBatch({
              ...initialQuery(),
              events: [event("same-a", "x", 15), event("same-b", "y", 16)],
            }),
          ),
        );
        expect(
          retries.filter((result) => result.acceptedEvents.length === 2),
        ).toHaveLength(1);
        expect(
          retries.filter((result) => result.deduplicatedCount === 2),
        ).toHaveLength(7);
        expect((await plane.readHead(initialQuery())).version).toMatchObject({
          snapshotId: 9,
          eventSeq: 17,
        });
      }));

    it("allows only one competing explicit predecessor and interoperates with existing single append receipts", () =>
      run(async (plane) => {
        const head = await plane.readHead(initialQuery());
        const single = (
          await BranchAppendCommand.create({
            ...initialQuery(),
            expected: head.version,
            event: event("single", "s", -1),
          })
        ).toRecord();
        await plane.append(single);
        const race = await Promise.allSettled([
          plane.appendBatch({
            ...initialQuery(),
            events: [event("a", "a", 0), event("b", "b", 1)],
          }),
          plane.appendBatch({
            ...initialQuery(),
            events: [event("c", "c", 0), event("d", "d", 1)],
          }),
        ]);
        expect(
          race.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        expect(
          race.find((result) => result.status === "rejected"),
        ).toMatchObject({ reason: { code: "diff_predecessor_mismatch" } });
        const replay = await plane.appendBatch({
          ...initialQuery(),
          events: [event("single", "s", -1)],
        });
        expect(replay.acknowledgements).toEqual([
          { eventId: "single", seq: 0, snapshotId: 1, status: "duplicate" },
        ]);
        expect(await plane.append(single)).toMatchObject({
          status: "duplicate",
          receipt: { version: { snapshotId: 1, eventSeq: 0 } },
        });
        const current = await plane.readHead(initialQuery());
        const after = (
          await BranchAppendCommand.create({
            ...initialQuery(),
            expected: current.version,
            event: event("after", "!", 2),
          })
        ).toRecord();
        expect(await plane.append(after)).toMatchObject({
          status: "accepted",
          receipt: { version: { snapshotId: 3, eventSeq: 3 } },
        });
        expect(
          (
            await plane.readEvents({
              ...initialQuery(),
              version: (await plane.readHead(initialQuery())).version,
              startSeq: 0,
              endSeq: 3,
            })
          ).map((row) => row.snapshotId),
        ).toEqual([1, 2, 2, 3]);
      }));

    it("captures callers before async hashing and isolates result mutations", () =>
      run(async (plane) => {
        const command = { ...initialQuery(), events: [event("a"), event("b")] };
        const pending = plane.appendBatch(command);
        command.target.rootDropId = "changed";
        command.events[0].ops[0].text = "changed";
        command.events.splice(1);
        const result = await pending;
        expect(result.content).toBe("ab");
        result.branch.headSnapshotId = 700;
        result.acceptedEvents[0].ops[0].text = "changed";
        result.acknowledgements[0].seq = 700;
        const retry = await plane.appendBatch({
          ...initialQuery(),
          events: [event("a"), event("b")],
        });
        expect(retry.content).toBe("ab");
        expect(retry.acknowledgements[0].seq).toBe(0);
        await expect(
          plane.appendBatch({
            ...initialQuery(),
            placement: { routingVersion: 1, generation: 8 },
            events: [event("a")],
          }),
        ).rejects.toThrow("routing_generation_mismatch");
      }));

    it("matches the real legacy append service for native operations, empty envelopes and duplicate/new mixtures", async () => {
      const bucket = createSeededBucket();
      const { branch } = await resolveBranchForActor(
        bucket,
        rootDropId,
        accountId,
        null,
      );
      const backend = await factory.create({
        branch,
        content: "",
        placement: { routingVersion: 1, generation: 7 },
      });
      const query = {
        target: { rootDropId, branchId: branch.branchId },
        placement: { routingVersion: 1, generation: 7 },
      };
      const a = {
        ...event("a", "legacy disagrees", -1),
        dropId: rootDropId,
        ops: [
          {
            type: "insert" as const,
            text: "wrong",
            start: 0,
            end: 0,
            native: {
              op: DiffOp.INSERT,
              data: btoa("native"),
              range: { start: 0, end: 0 },
            },
          },
        ],
      };
      const b = {
        ...event("b"),
        dropId: rootDropId,
        ops: [{ native: { op: DiffOp.RETAIN, data: btoa("keep") } }],
      };
      const c = { ...event("c", "!", 1), dropId: rootDropId };
      const projection = (result: BranchBatchAppendResult) => ({
        content: result.content,
        acceptedEvents: result.acceptedEvents,
        acknowledgements: result.acknowledgements,
        deduplicatedCount: result.deduplicatedCount,
        totalStored: result.totalStored,
        head: [result.branch.headSnapshotId, result.branch.headEventSeq],
        snapshot: result.snapshot && {
          id: result.snapshot.snapshotId,
          eventIds: result.snapshot.eventIds,
          start: result.snapshot.patchStartSeq,
          end: result.snapshot.patchEndSeq,
        },
      });
      try {
        for (const events of [[], [a, b, a], [b, c, c], [a, c], []]) {
          const legacy = await appendEventsToBranch(bucket, branch, events);
          const actual = await backend.plane.appendBatch({ ...query, events });
          expect(projection(actual)).toEqual(projection(legacy));
        }
      } finally {
        backend.close();
      }
    });
  });

describe("SQLite batch publication and durable recovery", () => {
  it("rolls back every publication statement before/after failure, including the single batch outbox intent", async () => {
    for (const phase of ["before", "after"] as const)
      for (let failed = 1; failed <= 7; failed++) {
        const raw = new LocalBranchSqlite();
        let armed = false,
          writes = 0;
        const sql: BranchSqlPort = {
          rows: (query, ...bindings) => raw.rows(query, ...bindings),
          transaction: (body) => raw.transaction(body),
          execute: (query, ...bindings) => {
            if (armed && ++writes === failed && phase === "before")
              throw Error("injected");
            raw.execute(query, ...bindings);
            if (armed && writes === failed && phase === "after")
              throw Error("injected");
          },
        };
        try {
          const plane = await SqliteBranchCommitStatePlane.create(sql, [
            contractSeed(),
          ]);
          armed = true;
          await expect(
            plane.appendBatch({
              ...initialQuery(),
              events: [event("a"), event("b")],
            }),
          ).rejects.toThrow("state_unavailable");
          armed = false;
          for (const table of [
            "branch_events",
            "branch_receipts",
            "branch_outbox",
          ])
            expect(raw.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n).toBe(0);
          expect(
            raw.rows("SELECT COUNT(*) AS n FROM branch_snapshots")[0].n,
          ).toBe(1);
          expect((await plane.readHead(initialQuery())).version.eventSeq).toBe(
            -1,
          );
          await plane.appendBatch({
            ...initialQuery(),
            events: [event("c"), event("d")],
          });
          const outbox = JSON.parse(
            raw.rows<{ outbox_json: string }>(
              "SELECT outbox_json FROM branch_outbox",
            )[0].outbox_json,
          );
          expect(outbox).toMatchObject({
            kind: "branch.batch-commit.v1",
            eventIds: ["c", "d"],
            version: { snapshotId: 1, eventSeq: 1 },
          });
          expect(
            outbox.receipts.map(
              (receipt: {
                eventSeq: number;
                version: { eventSeq: number };
              }) => [receipt.eventSeq, receipt.version.eventSeq],
            ),
          ).toEqual([
            [0, 1],
            [1, 1],
          ]);
          expect(raw.rows("SELECT COUNT(*) AS n FROM branch_outbox")[0].n).toBe(
            1,
          );
        } finally {
          raw.close();
        }
      }
  });

  it("reopens batch history and preserves receipts after a postcommit lost response", async () => {
    const directory = mkdtempSync(join(tmpdir(), "branch-batch-"));
    const filename = join(directory, "state.sqlite");
    let raw = new LocalBranchSqlite(filename);
    let armed = false,
      wrote = false;
    const sql: BranchSqlPort = {
      rows: (query, ...bindings) => raw.rows(query, ...bindings),
      execute: (query, ...bindings) => {
        raw.execute(query, ...bindings);
        wrote = true;
      },
      transaction: (body) => {
        wrote = false;
        const result = raw.transaction(body);
        if (armed && wrote) {
          armed = false;
          throw Error("response lost");
        }
        return result;
      },
    };
    try {
      const plane = await SqliteBranchCommitStatePlane.create(sql, [
        contractSeed(),
      ]);
      armed = true;
      await expect(
        plane.appendBatch({
          ...initialQuery(),
          events: [event("a"), event("b")],
        }),
      ).rejects.toThrow("state_unavailable");
      raw.close();
      raw = new LocalBranchSqlite(filename);
      const reopened = new SqliteBranchCommitStatePlane(raw);
      const retry = await reopened.appendBatch({
        ...initialQuery(),
        events: [event("a"), event("b")],
      });
      expect(retry).toMatchObject({
        content: "ab",
        snapshot: null,
        deduplicatedCount: 2,
      });
      expect(
        retry.acknowledgements.map((ack) => [
          ack.seq,
          ack.snapshotId,
          ack.status,
        ]),
      ).toEqual([
        [0, 1, "duplicate"],
        [1, 1, "duplicate"],
      ]);
      expect(raw.rows("SELECT COUNT(*) AS n FROM branch_outbox")[0].n).toBe(1);
    } finally {
      raw.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects corrupted batch receipt sequences and snapshot membership", async () => {
    for (const corruption of ["receipt", "snapshot"]) {
      const raw = new LocalBranchSqlite();
      try {
        const plane = await SqliteBranchCommitStatePlane.create(raw, [
          contractSeed(),
        ]);
        await plane.appendBatch({
          ...initialQuery(),
          events: [event("a"), event("b")],
        });
        if (corruption === "receipt")
          raw.execute(
            "UPDATE branch_receipts SET receipt_json = json_set(receipt_json, '$.eventSeq', 1) WHERE event_id = ?",
            JSON.stringify("a"),
          );
        else
          raw.execute(
            "UPDATE branch_snapshots SET snapshot_json = json_set(snapshot_json, '$.eventIds[0]', 'wrong') WHERE snapshot_id = 1",
          );
        await expect(
          plane.appendBatch({ ...initialQuery(), events: [event("a")] }),
        ).rejects.toThrow("state_corrupt");
      } finally {
        raw.close();
      }
    }
  });
});

it("routes one captured batch RPC and translates batch failures without flattening events", async () => {
  const memory = await MemoryBranchCommitStatePlane.create([contractSeed()]);
  let calls = 0;
  const plane = new RpcBranchCommitStatePlane(() => ({
    append: (command) => branchStateRpcResult(() => memory.append(command)),
    readHead: (query) => branchStateRpcResult(() => memory.readHead(query)),
    readContent: (query) =>
      branchStateRpcResult(() => memory.readContent(query)),
    readEvents: (query) => branchStateRpcResult(() => memory.readEvents(query)),
    appendBatch: (command) => {
      calls++;
      return branchStateRpcResult(() => memory.appendBatch(command));
    },
  }));
  const input = { ...initialQuery(), events: [event("a"), event("b")] };
  const pending = plane.appendBatch(input);
  input.events[0].ops[0].text = "changed";
  expect((await pending).content).toBe("ab");
  expect(calls).toBe(1);
  expect(
    (
      await plane.readEvents({
        ...initialQuery(),
        version: (await plane.readHead(initialQuery())).version,
        startSeq: 0,
        endSeq: 1,
      })
    ).map((row) => row.snapshotId),
  ).toEqual([1, 1]);
  await expect(
    plane.appendBatch({ ...initialQuery(), events: [event("c", "c", -1)] }),
  ).rejects.toThrow("diff_predecessor_mismatch");
});

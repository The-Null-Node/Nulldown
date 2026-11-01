import { describe, expect, it } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryBranchCommitStatePlane } from "./memory-commits";
import { SqliteBranchCommitStatePlane } from "./sqlite-commits";
import { LocalBranchSqlite } from "./local-sqlite";
import { observeBranchSql } from "./sqlite-port";
import {
  contractSeed,
  initialQuery,
  referenceSourceHash,
  contractEvent,
} from "./testing/commit-contract";
import {
  canonicalRuntimeFactJson,
  captureRuntimeFactAppend,
  runtimeFactIdentity,
  type BranchRuntimeFactAppendCommand,
} from "../../../shared/drop/branch-runtime-facts";
import {
  RpcBranchCommitStatePlane,
  branchStateRpcResult,
  type BranchStateRpcStub,
} from "../../../packages/nulldown-state-plane/src/shard-router";

const command = (id = "fact"): BranchRuntimeFactAppendCommand => ({
  ...initialQuery(),
  actorAccountId: "fixture-owner",
  fact: {
    version: 1,
    kind: "ui.state.patch",
    id,
    callId: "call",
    createdAt: 1,
    source: {
      ...initialQuery().target,
      sourceContentHash: referenceSourceHash(""),
    },
    patch: [{ op: "set", path: ["field"], value: "\ud800" }],
  },
});

for (const backend of ["memory", "sqlite"] as const) {
  describe(`runtime facts: ${backend}`, () => {
    const open = async (now = () => 1000) => {
      const sql = backend === "sqlite" ? new LocalBranchSqlite() : undefined;
      const plane = sql
        ? await SqliteBranchCommitStatePlane.create(sql, [contractSeed()], {
            now,
          })
        : await MemoryBranchCommitStatePlane.create([contractSeed()], now);
      return { plane, close: () => sql?.close() };
    };
    it("converges concurrent retries, keeps full extension intent, and survives subsequent document appends", async () => {
      const { plane, close } = await open();
      try {
        const input = JSON.parse(
          JSON.stringify({
            ...command(),
            fact: {
              ...command().fact,
              extension: { nested: "\ud800" },
              metadata: { actorAccountId: "forged" },
            },
          }),
        );
        Object.defineProperty(input.fact, "__proto__", {
          enumerable: true,
          value: { retained: true },
        });
        const results = await Promise.all(
          Array.from({ length: 8 }, () => plane.appendRuntimeFact(input)),
        );
        expect(results.filter((result) => result.appended)).toHaveLength(1);
        expect(results.map((result) => result.receipt)).toEqual(
          Array(8).fill(results[0].receipt),
        );
        expect(results[0].receipt.event.fact.metadata?.actorAccountId).toBe(
          "fixture-owner",
        );
        expect(
          JSON.parse(JSON.stringify(results[0].receipt.event.fact)).__proto__,
        ).toEqual({ retained: true });
        const changed = structuredClone(input);
        changed.fact.extension.nested = "\ufffd";
        await expect(plane.appendRuntimeFact(changed)).rejects.toMatchObject({
          code: "idempotency_key_reused",
        });
        await plane.appendBatch({
          ...initialQuery(),
          events: [contractEvent("edit", "new content", -1)],
        });
        const retried = await plane.appendRuntimeFact({
          ...input,
          fact: {
            ...input.fact,
            createdAt: 999,
            source: { ...input.fact.source, snapshotId: 999 },
          },
        });
        expect(retried).toEqual({ ...results[0], appended: false });
        await expect(
          plane.appendRuntimeFact(command("new-stale")),
        ).rejects.toMatchObject({ code: "stale_source" });
        expect(await plane.readRuntimeFactHead(initialQuery())).toEqual({
          ...initialQuery(),
          headSeq: 0,
        });
        const page = await plane.readRuntimeFacts({
          ...initialQuery(),
          headSeq: 0,
          afterSeq: -1,
          limit: 200,
        });
        expect(page.facts).toEqual([results[0].receipt.event]);
        expect((await plane.readHead(initialQuery())).version.snapshotId).toBe(
          1,
        );
      } finally {
        close();
      }
    });
    it("rejects exact-identity aliases without collapsing colon, sanitized or UTF-16 tuples", async () => {
      const { plane, close } = await open();
      try {
        for (const [a, b] of [
          ["a:b", "a"],
          ["slash/", "slash_"],
          ["\ud800", "\ufffd"],
        ]) {
          const first = command(a === "a:b" ? "c" : "same");
          if (first.fact.kind !== "ui.state.patch") throw Error();
          first.fact.callId = a;
          const second = structuredClone(first);
          second.fact.callId = b;
          if (a === "a:b") second.fact.id = "b:c";
          expect(runtimeFactIdentity(first.fact)).not.toBe(
            runtimeFactIdentity(second.fact),
          );
          await plane.appendRuntimeFact(first);
          await expect(plane.appendRuntimeFact(second)).rejects.toMatchObject({
            code: "idempotency_key_reused",
          });
        }
        expect((await plane.readRuntimeFactHead(initialQuery())).headSeq).toBe(
          2,
        );
      } finally {
        close();
      }
    });
    it("rechecks freshness at publication after a document append interleaves with fact hashing", async () => {
      const { plane, close } = await open();
      const subtle = crypto.subtle;
      const descriptor = Object.getOwnPropertyDescriptor(subtle, "digest");
      const original = subtle.digest.bind(subtle);
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      Object.defineProperty(subtle, "digest", {
        configurable: true,
        value: async (...args: Parameters<SubtleCrypto["digest"]>) => {
          if (
            new TextDecoder()
              .decode(args[1])
              .includes("nulldown.branch-runtime-fact.v1\n")
          ) {
            enter();
            await released;
          }
          return original(...args);
        },
      });
      try {
        const pending = plane.appendRuntimeFact(command());
        await entered;
        await plane.appendBatch({
          ...initialQuery(),
          events: [contractEvent("race", "changed", -1)],
        });
        release();
        await expect(pending).rejects.toMatchObject({ code: "stale_source" });
        expect((await plane.readRuntimeFactHead(initialQuery())).headSeq).toBe(
          -1,
        );
        const current = command();
        current.fact.source.sourceContentHash = referenceSourceHash("changed");
        expect(
          (await plane.appendRuntimeFact(current)).receipt.event.fact.source
            .snapshotId,
        ).toBe(1);
      } finally {
        release();
        if (descriptor) Object.defineProperty(subtle, "digest", descriptor);
        else Reflect.deleteProperty(subtle, "digest");
        close();
      }
    });
    it("accepts exactly one of concurrent conflicting intents and bounds pages at 200", async () => {
      const { plane, close } = await open();
      try {
        const other = command();
        if (other.fact.kind !== "ui.state.patch") throw Error();
        other.fact.reason = "conflict";
        const outcomes = await Promise.allSettled([
          plane.appendRuntimeFact(command()),
          plane.appendRuntimeFact(other),
        ]);
        expect(
          outcomes.filter((row) => row.status === "fulfilled"),
        ).toHaveLength(1);
        expect(outcomes.find((row) => row.status === "rejected")).toMatchObject(
          { reason: { code: "idempotency_key_reused" } },
        );
        await Promise.all(
          Array.from({ length: 200 }, (_, i) =>
            plane.appendRuntimeFact(command(`page-${i}`)),
          ),
        );
        const head = await plane.readRuntimeFactHead(initialQuery());
        const first = await plane.readRuntimeFacts({
          ...head,
          afterSeq: -1,
          limit: 200,
        });
        expect(first.facts.map((fact) => fact.seq)).toEqual(
          Array.from({ length: 200 }, (_, i) => i),
        );
        expect(first.nextCursor).toBe(199);
        expect(
          (
            await plane.readRuntimeFacts({ ...head, afterSeq: 199, limit: 200 })
          ).facts.map((fact) => fact.seq),
        ).toEqual([200]);
        await expect(
          plane.readRuntimeFacts({ ...head, afterSeq: -1, limit: 201 }),
        ).rejects.toMatchObject({ code: "invalid_command" });
      } finally {
        close();
      }
    });
    it("checks actor and generation before duplicates; pins pages and preserves rollback clocks and snapshots", async () => {
      let clock = 3000;
      const { plane, close } = await open(() => clock);
      try {
        const before = await plane.readHead(initialQuery());
        const first = await plane.appendRuntimeFact(command());
        const head = await plane.readRuntimeFactHead(initialQuery());
        clock = 10;
        const second = await plane.appendRuntimeFact(command("second"));
        expect(second.receipt.event.createdAt).toBe(10);
        expect(second.receipt.event.seq).toBe(1);
        expect(await plane.readHead(initialQuery())).toEqual(before);
        await expect(
          plane.appendRuntimeFact({ ...command(), actorAccountId: "intruder" }),
        ).rejects.toMatchObject({ code: "forbidden" });
        await expect(
          plane.appendRuntimeFact({
            ...command(),
            placement: { routingVersion: 1, generation: 8 },
          }),
        ).rejects.toMatchObject({ code: "routing_generation_mismatch" });
        const missingHash = command("missing");
        delete missingHash.fact.source.sourceContentHash;
        await expect(
          plane.appendRuntimeFact(missingHash),
        ).rejects.toMatchObject({ code: "source_hash_required" });
        expect(
          (await plane.readRuntimeFacts({ ...head, afterSeq: -1, limit: 200 }))
            .facts,
        ).toEqual([first.receipt.event]);
        expect(
          (await plane.readRuntimeFacts({ ...head, afterSeq: 0, limit: 200 }))
            .nextCursor,
        ).toBeNull();
        await expect(
          plane.readRuntimeFacts({
            ...head,
            headSeq: 2,
            afterSeq: -1,
            limit: 200,
          }),
        ).rejects.toMatchObject({ code: "invalid_command" });
      } finally {
        close();
      }
    });
    it("captures callers before async hashing and handles all three fact kinds", async () => {
      const { plane, close } = await open();
      try {
        const input = command();
        const pending = plane.appendRuntimeFact(input);
        input.fact.id = "mutated";
        expect((await pending).receipt.event.fact.id).toBe("fact");
        const source = command().fact.source;
        await plane.appendRuntimeFact({
          ...command(),
          fact: {
            version: 1,
            kind: "ui.state.snapshot",
            id: "s",
            callId: "c",
            createdAt: 1,
            source,
            state: { x: 1 },
          },
        });
        await plane.appendRuntimeFact({
          ...command(),
          fact: {
            version: 1,
            kind: "ui.response",
            id: "r",
            primitiveId: "p",
            createdAt: 1,
            source,
            data: { x: 1 },
          },
        });
        expect((await plane.readRuntimeFactHead(initialQuery())).headSeq).toBe(
          2,
        );
      } finally {
        close();
      }
    });
  });
}

describe("runtime fact SQL atomicity and persistence", () => {
  it("rolls back every publication cutpoint and replays the original receipt after reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "runtime-facts-"));
    const filename = join(directory, "state.sqlite");
    let sql = new LocalBranchSqlite(filename);
    const tables = [
      "branch_runtime_facts",
      "branch_runtime_fact_receipts",
      "branch_runtime_fact_heads",
      "branch_runtime_fact_outbox",
    ];
    try {
      await SqliteBranchCommitStatePlane.create(sql, [contractSeed()]);
      for (const table of tables) {
        const plane = new SqliteBranchCommitStatePlane(
          observeBranchSql(sql, (event) => {
            if (
              event.operation === "execute" &&
              event.phase === "after" &&
              event.sql?.startsWith(`INSERT INTO ${table} `)
            )
              throw Error("cut");
          }),
        );
        await expect(plane.appendRuntimeFact(command())).rejects.toMatchObject({
          code: "state_unavailable",
        });
        for (const name of tables)
          expect(
            sql.rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name}`)[0].n,
          ).toBe(0);
      }
      const plane = new SqliteBranchCommitStatePlane(sql, { now: () => 1234 });
      const accepted = await plane.appendRuntimeFact(command());
      sql.close();
      sql = new LocalBranchSqlite(filename);
      const reopened = new SqliteBranchCommitStatePlane(sql, { now: () => 1 });
      expect(await reopened.appendRuntimeFact(command())).toEqual({
        ...accepted,
        appended: false,
      });
      for (const name of tables)
        expect(
          sql.rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name}`)[0].n,
        ).toBe(1);
      expect(
        sql.rows<{ identity: string }>(
          "SELECT identity FROM branch_runtime_facts",
        )[0].identity,
      ).toBe(JSON.stringify(["ui.state.patch", "call", "fact"]));
    } finally {
      sql.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("runtime fact RPC validation", () => {
  it("rejects forged scope, placement, identity, hash, intent, sequence and incomplete pages", async () => {
    const plane = await MemoryBranchCommitStatePlane.create([contractSeed()]);
    const result = await plane.appendRuntimeFact(command());
    const stub: BranchStateRpcStub = {
      append: (input) => branchStateRpcResult(() => plane.append(input)),
      readHead: (input) => branchStateRpcResult(() => plane.readHead(input)),
      readContent: (input) =>
        branchStateRpcResult(() => plane.readContent(input)),
      readEvents: (input) =>
        branchStateRpcResult(() => plane.readEvents(input)),
      appendRuntimeFact: async () => ({ ok: true, value: result }),
      readRuntimeFactHead: (input) =>
        branchStateRpcResult(() => plane.readRuntimeFactHead(input)),
      readRuntimeFacts: (input) =>
        branchStateRpcResult(() => plane.readRuntimeFacts(input)),
    };
    const rpc = new RpcBranchCommitStatePlane(() => stub);
    expect(await rpc.appendRuntimeFact(command())).toEqual(result);
    for (const modify of [
      (r: typeof result) => {
        r.target.rootDropId = "wrong";
      },
      (r: typeof result) => {
        r.placement.generation++;
      },
      (r: typeof result) => {
        r.receipt.identity = "wrong";
      },
      (r: typeof result) => {
        r.receipt.payloadHash = referenceSourceHash("wrong");
      },
      (r: typeof result) => {
        r.receipt.event.fact.id = "wrong";
      },
      (r: typeof result) => {
        r.receipt.event.seq = 0.5;
      },
    ]) {
      const forged = structuredClone(result);
      modify(forged);
      stub.appendRuntimeFact = async () => ({ ok: true, value: forged });
      await expect(rpc.appendRuntimeFact(command())).rejects.toMatchObject({
        code: "state_corrupt",
      });
    }
    const head = await rpc.readRuntimeFactHead(initialQuery());
    expect(
      (await rpc.readRuntimeFacts({ ...head, afterSeq: -1, limit: 200 })).facts,
    ).toHaveLength(1);
    stub.readRuntimeFacts = async () => ({
      ok: true,
      value: { ...head, facts: [], nextCursor: null },
    });
    await expect(
      rpc.readRuntimeFacts({ ...head, afterSeq: -1, limit: 200 }),
    ).rejects.toMatchObject({ code: "state_corrupt" });
  });
  it("rejects non-JSON extensions while retaining exact arbitrary JSON keys", () => {
    for (const value of [
      undefined,
      NaN,
      Infinity,
      new Date(),
      () => 1,
      Symbol("x"),
      BigInt(1),
    ]) {
      expect(() =>
        captureRuntimeFactAppend({
          ...command(),
          fact: { ...command().fact, extension: value },
        } as BranchRuntimeFactAppendCommand),
      ).toThrow();
    }
    expect(
      canonicalRuntimeFactJson(
        JSON.parse('{"__proto__":{"x":1},"z":"\\ud800"}'),
      ),
    ).toBe('{"__proto__":{"x":1},"z":"\\ud800"}');
  });
});

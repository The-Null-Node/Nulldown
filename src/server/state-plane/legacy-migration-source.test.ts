import { describe, expect, it } from "@jest/globals";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  createSeededBucket,
  accountId,
  rootDropId,
  makeEvent,
} from "../../../functions/api/_lib/diffs/testing/storage-fixture";
import { resolveBranchForActor } from "../../../functions/api/_lib/branches/lifecycle";
import { appendEventsToBranch } from "../../../functions/api/_lib/nulledit/service";
import { createBranchRepository } from "../../../functions/api/_lib/branches/storage/repository";
import { createBranchRuntimeFactLogRepository } from "../../../functions/api/_lib/branches/storage/runtime-fact-log";
import { createSqlNullMemRecordStore } from "../stores/nullmem-record-store";
import type { SqlMetadataStore, SqlStatement } from "../ports";
import { captureLegacyMigrationSource } from "./legacy-migration-source";
import { SqliteSourceWriteFence } from "./source-fence";
import { LocalBranchSqlite } from "./local-sqlite";
import { hashNulldownSourceContent } from "../../../shared/drop/resolved/hash";
import { buildLegacyMigrationPayload } from "./legacy-migration-payload";
import { captureBranchMigrationChunk } from "../../../shared/drop/branch-migration";

async function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(
    `CREATE TABLE nullmem_records(record_kind TEXT,record_id TEXT,root_drop_id TEXT,branch_id TEXT,target_kind TEXT,target_id TEXT,text TEXT,labels_json TEXT,priority INTEGER,confidence REAL,created_at INTEGER,updated_at INTEGER,record_json TEXT,PRIMARY KEY(root_drop_id,branch_id,record_kind,record_id)); CREATE TABLE resolved_priority_facts(root_drop_id TEXT,branch_id TEXT);`,
  );
  const sql: SqlMetadataStore = {
    prepare(query) {
      let values: SQLInputValue[] = [];
      const statement: SqlStatement = {
        bind(...input) {
          values = input as SQLInputValue[];
          return statement;
        },
        async run() {
          return database.prepare(query).run(...values);
        },
        async first<T>() {
          return (database.prepare(query).get(...values) ?? null) as T | null;
        },
        async all<T>() {
          return { results: database.prepare(query).all(...values) as T[] };
        },
      };
      return statement;
    },
  };
  const gateSql = new LocalBranchSqlite();
  const gate = new SqliteSourceWriteFence(gateSql);
  const blobs = createSeededBucket();
  const target = { rootDropId, branchId: "owner" };
  gate.register(target);
  const permit = gate.admit({ target, generation: 0, requestId: "seed" });
  const { branch } = await resolveBranchForActor(
    blobs,
    rootDropId,
    accountId,
    null,
  );
  expect(branch.branchId).toBe(target.branchId);
  const first = await appendEventsToBranch(blobs, branch, [
    makeEvent({
      eventId: "first",
      text: "A",
      sourceClientId: "client",
      createdAt: 10,
    }),
  ]);
  const second = await appendEventsToBranch(blobs, first.branch, [
    makeEvent({
      eventId: "second",
      text: "B",
      sourceClientId: "client",
      createdAt: 11,
    }),
  ]);
  const fact = await createBranchRuntimeFactLogRepository({
    blobs,
  }).appendBranchRuntimeFact(rootDropId, branch.branchId, {
    version: 1,
    kind: "ui.state.patch",
    id: "runtime",
    callId: "call",
    createdAt: 12,
    source: {
      ...target,
      sourceContentHash: await hashNulldownSourceContent(second.content),
    },
    patch: [{ op: "set", path: ["value"], value: "\ud800" }],
  });
  const memory = createSqlNullMemRecordStore(sql);
  for (let i = 0; i < 205; i++)
    await memory.put({
      version: 1,
      kind: "fact",
      recordId: `fact-${String(i).padStart(3, "0")}`,
      ...target,
      text: `memory ${i}`,
      createdAt: 13,
    });
  gate.complete(permit);
  const certificate = { target, sourceGeneration: 0, migrationId: "export" };
  gate.fence(certificate);
  const options = {
    blobs,
    sql,
    target,
    async assertFrozen() {
      gate.assertFrozen(certificate);
    },
  };
  return {
    options,
    gate,
    certificate,
    database,
    second,
    fact,
    close() {
      database.close();
      gateSql.close();
    },
  };
}

describe("frozen legacy migration capture", () => {
  it("captures real legacy history and exact paged memory without manufacturing identities", async () => {
    const f = await fixture();
    try {
      const result = await captureLegacyMigrationSource(f.options);
      expect(result.branch).toEqual(f.second.branch);
      expect(result.snapshots).toHaveLength(3);
      expect(result.snapshots[2].content).toBe(f.second.content);
      expect(result.events.map((event) => event.eventId)).toEqual([
        "first",
        "second",
      ]);
      expect(result.runtimeFacts).toEqual([f.fact.event]);
      expect(result.memoryRecords).toHaveLength(205);
      expect(await captureLegacyMigrationSource(f.options)).toEqual(result);
      const exported = await buildLegacyMigrationPayload(result, {
        migrationId: "export",
        sourceId: "source",
        sourceGeneration: 0,
        certification: "private-attestation",
      });
      expect(exported.manifest.generation).toBe(1);
      const records = (
        await Promise.all(exported.chunks.map(captureBranchMigrationChunk))
      ).flatMap((chunk) => chunk.payload);
      expect(
        records
          .filter((record) => record.kind === "event")
          .map((record) => record.value.acknowledgement),
      ).toEqual([
        { eventId: "first", seq: 0, snapshotId: 1, status: "accepted" },
        { eventId: "second", seq: 1, snapshotId: 2, status: "accepted" },
      ]);
      expect(
        records.find((record) => record.kind === "nullmem")?.value,
      ).toEqual({ revision: 0, records: result.memoryRecords, outbox: [] });
    } finally {
      f.close();
    }
  });

  it("rejects bounds, unsupported global defaults, and lost source fences", async () => {
    const f = await fixture();
    try {
      await expect(
        captureLegacyMigrationSource({ ...f.options, maxMemoryRecords: 200 }),
      ).rejects.toMatchObject({ code: "capability_unsupported" });
      await expect(
        captureLegacyMigrationSource({ ...f.options, maxBytes: 20 }),
      ).rejects.toMatchObject({ code: "capability_unsupported" });
      f.database.exec(
        "INSERT INTO nullmem_records(record_kind,record_id,root_drop_id,branch_id) VALUES('fact','global','','')",
      );
      await expect(
        captureLegacyMigrationSource(f.options),
      ).rejects.toMatchObject({ code: "capability_unsupported" });
      f.database.exec("DELETE FROM nullmem_records WHERE record_id='global'");
      f.gate.abort(f.certificate);
      await expect(
        captureLegacyMigrationSource(f.options),
      ).rejects.toMatchObject({ code: "routing_placement_mismatch" });
    } finally {
      f.close();
    }
  });

  it("rejects changed canonical source even when an external writer bypasses the gate", async () => {
    const f = await fixture();
    try {
      let checks = 0;
      await expect(
        captureLegacyMigrationSource({
          ...f.options,
          async assertFrozen() {
            await f.options.assertFrozen();
            if (++checks === 3)
              await createBranchRepository({
                blobs: f.options.blobs,
              }).writeBranch({
                ...f.second.branch,
                updatedAt: f.second.branch.updatedAt + 1,
              });
          },
        }),
      ).rejects.toMatchObject({ code: "routing_placement_mismatch" });
    } finally {
      f.close();
    }
  });

  it("rejects a snapshot whose recorded content hash disagrees with replay", async () => {
    const f = await fixture();
    try {
      const repository = createBranchRepository({ blobs: f.options.blobs });
      const snapshot = await repository.readSnapshot(rootDropId, "owner", 2);
      expect(snapshot).not.toBeNull();
      await repository.writeSnapshot({
        ...snapshot!,
        sourceContentHash: await hashNulldownSourceContent("not the source"),
      });
      await expect(
        captureLegacyMigrationSource(f.options),
      ).rejects.toMatchObject({ code: "state_corrupt" });
    } finally {
      f.close();
    }
  });

  it("includes an admitted legacy append that settles after admissions close", async () => {
    const f = await fixture();
    try {
      f.gate.abort(f.certificate);
      const permit = f.gate.admit({
        target: f.options.target,
        generation: 1,
        requestId: "in-flight-append",
      });
      const certificate = {
        target: f.options.target,
        sourceGeneration: 1,
        migrationId: "after-drain",
      };
      expect(f.gate.fence(certificate)).toMatchObject({
        phase: "draining",
        active: 1,
      });
      const options = {
        ...f.options,
        async assertFrozen() {
          f.gate.assertFrozen(certificate);
        },
      };
      await expect(captureLegacyMigrationSource(options)).rejects.toMatchObject(
        { code: "routing_placement_mismatch" },
      );
      const appended = await appendEventsToBranch(
        f.options.blobs,
        f.second.branch,
        [
          makeEvent({
            eventId: "drained",
            text: "C",
            sourceClientId: "client",
            createdAt: 20,
          }),
        ],
      );
      f.gate.complete(permit);
      f.gate.fence(certificate);
      const captured = await captureLegacyMigrationSource(options);
      expect(captured.branch).toEqual(appended.branch);
      expect(captured.events.at(-1)?.eventId).toBe("drained");
      expect(captured.snapshots.at(-1)?.content).toBe(appended.content);
    } finally {
      f.close();
    }
  });
});

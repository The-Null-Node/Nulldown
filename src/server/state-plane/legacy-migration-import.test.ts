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
import { createBranchRuntimeFactLogRepository } from "../../../functions/api/_lib/branches/storage/runtime-fact-log";
import { createSqlNullMemRecordStore } from "../stores/nullmem-record-store";
import type { SqlMetadataStore, SqlStatement } from "../ports";
import { hashNulldownSourceContent } from "../../../shared/drop/resolved/hash";
import { captureLegacyMigrationSource } from "./legacy-migration-source";
import { buildLegacyMigrationPayload } from "./legacy-migration-payload";
import { SqliteSourceWriteFence } from "./source-fence";
import { LocalBranchSqlite } from "./local-sqlite";
import { observeBranchSql } from "./sqlite-port";
import { SqliteBranchCommitStatePlane } from "./sqlite-commits";
import { SqliteBranchMigrationStaging } from "./sqlite-migration";

describe("real legacy source to authoritative State Plane import", () => {
  it("captures, packs, imports, activates and reads the actual legacy repositories", async () => {
    const metadataDb = new DatabaseSync(":memory:");
    metadataDb.exec(
      "CREATE TABLE nullmem_records(record_kind TEXT,record_id TEXT,root_drop_id TEXT,branch_id TEXT,target_kind TEXT,target_id TEXT,text TEXT,labels_json TEXT,priority INTEGER,confidence REAL,created_at INTEGER,updated_at INTEGER,record_json TEXT,PRIMARY KEY(root_drop_id,branch_id,record_kind,record_id)); CREATE TABLE resolved_priority_facts(root_drop_id TEXT,branch_id TEXT);",
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
            return metadataDb.prepare(query).run(...values);
          },
          async first<T>() {
            return (metadataDb.prepare(query).get(...values) ??
              null) as T | null;
          },
          async all<T>() {
            return { results: metadataDb.prepare(query).all(...values) as T[] };
          },
        };
        return statement;
      },
    };
    const target = { rootDropId, branchId: "owner" };
    const gateSql = new LocalBranchSqlite();
    const gate = new SqliteSourceWriteFence(gateSql);
    gate.register(target);
    const migrationId = "legacy-source-import";
    const certificate = { target, sourceGeneration: 0, migrationId };
    const permit = gate.admit({
      target,
      generation: 0,
      requestId: "real-legacy-write",
    });
    const blobs = createSeededBucket();
    const { branch } = await resolveBranchForActor(
      blobs,
      rootDropId,
      accountId,
      null,
    );
    const first = await appendEventsToBranch(blobs, branch, [
      makeEvent({
        eventId: "real-legacy-1",
        text: "hello",
        sourceClientId: "client",
        createdAt: 10,
      }),
    ]);
    const latest = await appendEventsToBranch(blobs, first.branch, [
      makeEvent({
        eventId: "real-legacy-2",
        text: " world",
        sourceClientId: "client",
        createdAt: 11,
      }),
    ]);
    const runtime = await createBranchRuntimeFactLogRepository({
      blobs,
    }).appendBranchRuntimeFact(rootDropId, branch.branchId, {
      version: 1,
      kind: "ui.state.patch",
      id: "runtime-legacy",
      callId: "call",
      createdAt: 12,
      source: {
        ...target,
        sourceContentHash: await hashNulldownSourceContent(latest.content),
      },
      patch: [{ op: "set", path: ["saved"], value: true }],
    });
    await createSqlNullMemRecordStore(sql).put({
      version: 1,
      kind: "fact",
      recordId: "legacy-memory",
      ...target,
      text: "kept",
      createdAt: 13,
    });
    gate.complete(permit);
    gate.fence(certificate);
    const captured = await captureLegacyMigrationSource({
      blobs,
      sql,
      target,
      assertFrozen: async () => gate.assertFrozen(certificate),
    });
    const payload = await buildLegacyMigrationPayload(captured, {
      migrationId,
      sourceId: "synthetic-legacy",
      sourceGeneration: 0,
      certification: "private-gate-certificate",
    });
    const targetSql = new LocalBranchSqlite();
    const sqlReads: string[] = [];
    const observedSql = observeBranchSql(targetSql, (event) => {
      if (event.operation === "rows" && event.phase === "before")
        sqlReads.push(event.sql!);
    });
    const plane = await SqliteBranchCommitStatePlane.create(observedSql);
    const importer = new SqliteBranchMigrationStaging(
      observedSql,
      gate,
      (manifest) =>
        manifest.fence.sourceHeadHash === captured.captureHash &&
        manifest.fence.sourceRevision === captured.branchEtag,
    );
    importer.admit(payload.manifest, certificate);
    for (const chunk of payload.chunks)
      await importer.putChunk(chunk, payload.manifest.generation);
    await importer.verify(
      migrationId,
      payload.manifest.generation,
      certificate,
    );
    await importer.activate(
      migrationId,
      payload.manifest.generation,
      certificate,
    );
    sqlReads.length = 0;
    const query = { target, placement: { routingVersion: 1, generation: 1 } };
    const head = await plane.readHead(query);
    expect(head.branch).toEqual(captured.branch);
    expect(sqlReads).toHaveLength(2);
    expect(
      (await plane.readContent({ ...query, version: head.version })).content,
    ).toBe(latest.content);
    for (const [snapshotId, source] of captured.snapshots.entries())
      expect(
        (await plane.readSnapshot({ ...query, snapshotId }))?.snapshot,
      ).toEqual(source.snapshot);
    sqlReads.length = 0;
    await plane.listSnapshots({
      ...query,
      version: head.version,
      afterSnapshotId: -1,
      limit: 10,
    });
    expect(sqlReads).toHaveLength(3);
    sqlReads.length = 0;
    expect(
      await plane.readEvents({
        ...query,
        version: head.version,
        startSeq: 0,
        endSeq: 1,
      }),
    ).toEqual(captured.events);
    expect(sqlReads).toHaveLength(3);
    expect(
      (
        await plane.readRuntimeFacts({
          ...query,
          headSeq: 0,
          afterSeq: -1,
          limit: 10,
        })
      ).facts,
    ).toEqual([runtime.event]);
    expect(
      (await plane.queryNullMem({ ...query, limit: 10 })).records.map(
        (record) => record.recordId,
      ),
    ).toEqual(["legacy-memory"]);
    expect(
      targetSql.rows(
        "SELECT acknowledgement_json,provenance FROM branch_migration_public_acks ORDER BY event_id",
      ),
    ).toHaveLength(2);
    expect(
      (
        await plane.claimOutbox({
          leaseId: "migration-no-replay",
          now: 100,
          leaseMs: 1_000,
          limit: 10,
        })
      ).items,
    ).toHaveLength(0);
    expect(targetSql.rows("SELECT 1 FROM branch_outbox_delivery")).toHaveLength(
      0,
    );
    targetSql.close();
    gateSql.close();
    metadataDb.close();
  });
});

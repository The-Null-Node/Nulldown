import { describe, expect, it } from "@jest/globals";
import assert from "node:assert/strict";
import type {
  BranchMigrationChunk,
  BranchMigrationManifest,
  BranchMigrationRecord,
} from "../../../shared/drop/branch-migration";
import { hashMigrationPayload } from "../../../shared/drop/branch-migration";
import { hashNulldownSourceContent } from "../../../shared/drop/resolved/hash";
import { hashBranchBatchEvents } from "../../../shared/drop/branch-batch";
import { validateNullMemQueryResult } from "../../../shared/drop/branch-nullmem";
import {
  branchStateRpcResult,
  RpcBranchCommitStatePlane,
} from "../../../packages/nulldown-state-plane/src/shard-router";
import { nullplugUiRuntimeFactId } from "../../../shared/nullplug/ui";
import type {
  DropBranchRuntimeFact,
  DropDiffEvent,
} from "../../../shared/drop/diff";
import { LocalBranchSqlite } from "./local-sqlite";
import { SqliteBranchCommitStatePlane } from "./sqlite-commits";
import { SqliteBranchMigrationStaging } from "./sqlite-migration";
import {
  SqliteSourceWriteFence,
  type SourceFenceCertificate,
} from "./source-fence";
import type { BranchSqlPort, BranchSqlValue } from "./sqlite-port";

const target = { rootDropId: "MigrationRoot001", branchId: "owner" };
const sourceGeneration = 0;
const migrationId = "rehearsal-migration-1";
const cert = (): SourceFenceCertificate => ({
  target,
  sourceGeneration,
  migrationId,
});
const sourceHash = (content: string) => hashNulldownSourceContent(content);

async function fixture(): Promise<{
  records: BranchMigrationRecord[];
  manifest: BranchMigrationManifest;
  chunks: BranchMigrationChunk[];
}> {
  const contents = ["", "ab", "abc"];
  const hashes = await Promise.all(contents.map(sourceHash));
  const branch = {
    version: 1 as const,
    ...target,
    baseDropId: target.rootDropId,
    mode: "owner" as const,
    status: "active" as const,
    ownerAccountId: "synthetic-owner",
    writerAccountId: "synthetic-owner",
    writerClientId: null,
    headSnapshotId: 2,
    headEventSeq: 2,
    snapshotHeapVersion: 2,
    checkpointInterval: 24,
    createdAt: 1,
    updatedAt: 3,
  };
  const snapshots = [
    {
      version: 1 as const,
      ...target,
      snapshotId: 0,
      parentSnapshotId: null,
      seq: 0,
      eventIds: [],
      checkpointed: true,
      patchStartSeq: null,
      patchEndSeq: null,
      textLength: 0,
      createdAt: 1,
    },
    {
      version: 1 as const,
      ...target,
      snapshotId: 1,
      parentSnapshotId: 0,
      seq: 1,
      eventIds: ["event-0", "event-1"],
      checkpointed: false,
      patchStartSeq: 0,
      patchEndSeq: 1,
      textLength: 2,
      createdAt: 2,
    },
    {
      version: 1 as const,
      ...target,
      snapshotId: 2,
      parentSnapshotId: 1,
      seq: 2,
      eventIds: ["event-2"],
      checkpointed: true,
      patchStartSeq: 2,
      patchEndSeq: 2,
      textLength: 3,
      createdAt: 3,
    },
  ];
  const events: DropDiffEvent[] = [
    {
      eventId: "event-0",
      seq: 0,
      dropId: target.rootDropId,
      sourceClientId: "legacy-client",
      createdAt: 2,
      ops: [{ type: "insert", start: 0, end: 0, text: "a" }],
    },
    {
      eventId: "event-1",
      seq: 1,
      dropId: target.rootDropId,
      sourceClientId: "legacy-client",
      createdAt: 2,
      ops: [{ type: "insert", start: 1, end: 1, text: "b" }],
    },
    {
      eventId: "event-2",
      seq: 2,
      dropId: target.rootDropId,
      sourceClientId: "legacy-client",
      createdAt: 3,
      ops: [{ type: "insert", start: 2, end: 2, text: "c" }],
    },
  ];
  const fact = {
    version: 1 as const,
    kind: "ui.state.patch" as const,
    id: "runtime-0",
    callId: "call-0",
    createdAt: 9,
    source: { ...target, sourceContentHash: hashes[0] },
    patch: [{ op: "set" as const, path: ["value"], value: "legacy" }],
  };
  const runtime: DropBranchRuntimeFact = {
    version: 1,
    ...target,
    seq: 0,
    factId: nullplugUiRuntimeFactId(fact),
    createdAt: 10,
    fact,
  };
  const memory = {
    version: 1 as const,
    kind: "fact" as const,
    ...target,
    recordId: "memory-0",
    createdAt: 11,
    text: "legacy memory",
  };
  const records: BranchMigrationRecord[] = [
    { kind: "branch", value: branch },
    ...snapshots.map((snapshot, index) => ({
      kind: "snapshot" as const,
      value: { snapshot, content: contents[index], contentHash: hashes[index] },
    })),
    ...events.map((event) => {
      const snapshotId = snapshots.findIndex((snapshot) =>
        snapshot.eventIds.includes(event.eventId),
      );
      return {
        kind: "event" as const,
        value: {
          event,
          acknowledgement: {
            eventId: event.eventId,
            seq: event.seq,
            snapshotId,
            status: "accepted" as const,
          },
        },
      };
    }),
    { kind: "runtime-fact", value: runtime },
    { kind: "nullmem", value: { revision: 0, records: [memory], outbox: [] } },
  ];
  const chunks: BranchMigrationChunk[] = [];
  for (let i = 0; i < records.length; i += 4) {
    const payload = records.slice(i, i + 4);
    chunks.push({
      migrationId,
      index: chunks.length,
      payload,
      payloadHash: await hashMigrationPayload(payload),
    });
  }
  const manifest: BranchMigrationManifest = {
    migrationId,
    target,
    routingVersion: 1,
    generation: 1,
    fence: {
      sourceId: "synthetic-legacy",
      sourceGeneration,
      sourceRevision: "etag-r1",
      sourceHeadHash: `sha256:${"e".repeat(43)}`,
      certification: "private-source-gate-cert",
    },
    chunkCount: chunks.length,
    itemCount: records.length,
    payloadHash: await hashMigrationPayload(
      chunks.map((chunk) => chunk.payloadHash),
    ),
  };
  return { records, manifest, chunks };
}

function frozenSource(sql: LocalBranchSqlite): SqliteSourceWriteFence {
  const fence = new SqliteSourceWriteFence(sql);
  fence.register(target);
  fence.fence(cert());
  fence.assertFrozen(cert());
  return fence;
}

describe("SQLite semantic branch migration", () => {
  it("keeps identical imported event IDs isolated across branches in one shard", async () => {
    const sql = new LocalBranchSqlite();
    try {
      const plane = await SqliteBranchCommitStatePlane.create(sql);
      const fence = new SqliteSourceWriteFence(sql);
      const imports = [];
      for (const root of [target.rootDropId, "MigrationRoot002"]) {
        const value = await fixture();
        const id = `${migrationId}-${root}`;
        const nextTarget = { ...target, rootDropId: root };
        const certificate = {
          target: nextTarget,
          sourceGeneration: 0,
          migrationId: id,
        };
        const chunks = await Promise.all(
          value.chunks.map(async (chunk) => {
            const payload: BranchMigrationRecord[] = JSON.parse(
              JSON.stringify(chunk.payload).replaceAll(target.rootDropId, root),
            );
            return {
              ...chunk,
              migrationId: id,
              payload,
              payloadHash: await hashMigrationPayload(payload),
            };
          }),
        );
        const manifest = {
          ...value.manifest,
          migrationId: id,
          target: nextTarget,
          payloadHash: await hashMigrationPayload(
            chunks.map((chunk) => chunk.payloadHash),
          ),
        };
        fence.register(nextTarget);
        fence.fence(certificate);
        const staging = new SqliteBranchMigrationStaging(
          sql,
          fence,
          (supplied) => JSON.stringify(supplied) === JSON.stringify(manifest),
        );
        staging.admit(manifest, certificate);
        for (const chunk of chunks) await staging.putChunk(chunk, 1);
        await staging.verify(id, 1, certificate);
        await staging.activate(id, 1, certificate);
        imports.push(nextTarget);
      }
      for (const importedTarget of imports) {
        const query = {
          target: importedTarget,
          placement: { routingVersion: 1, generation: 1 },
        };
        const head = await plane.readHead(query);
        const events = await plane.readEvents({
          ...query,
          version: head.version,
          startSeq: 0,
          endSeq: 2,
        });
        expect(events).toHaveLength(3);
        expect(events.map((event) => event.eventId)).toEqual([
          "event-0",
          "event-1",
          "event-2",
        ]);
        expect(
          events.every((event) => event.dropId === importedTarget.rootDropId),
        ).toBe(true);
      }
    } finally {
      sql.close();
    }
  });

  it("imports exact multi-snapshot history, runtime facts and memory; activation is atomic and State Plane reads/writes continue", async () => {
    const sourceSql = new LocalBranchSqlite();
    const targetSql = new LocalBranchSqlite();
    const sourceFence = frozenSource(sourceSql);
    const { records, manifest, chunks } = await fixture();
    const targetPlane = await SqliteBranchCommitStatePlane.create(targetSql);
    const staging = new SqliteBranchMigrationStaging(
      targetSql,
      sourceFence,
      (value) => value.fence.sourceHeadHash === manifest.fence.sourceHeadHash,
    );
    expect(staging.admit(manifest, cert()).phase).toBe("importing");
    expect(staging.admit(manifest, cert()).nextChunk).toBe(0);
    for (const chunk of chunks)
      await staging.putChunk(chunk, manifest.generation);
    expect(
      (await staging.putChunk(chunks[0], manifest.generation)).nextChunk,
    ).toBe(chunks.length);
    expect(
      (await staging.verify(migrationId, manifest.generation, cert())).phase,
    ).toBe("verified");
    expect(await targetPlane.readPlacement({ target })).toBeNull();
    expect(
      staging.readVerifiedShadow(migrationId, "migration-shadow-read"),
    ).toEqual(records);
    expect(
      (await staging.activate(migrationId, manifest.generation, cert())).phase,
    ).toBe("activated");
    expect(sourceFence.read(target).phase).toBe("transferred");

    const query = {
      target,
      placement: { routingVersion: 1, generation: manifest.generation },
    };
    const head = await targetPlane.readHead(query);
    expect(head.version.snapshotId).toBe(2);
    expect(head.version.eventSeq).toBe(2);
    for (const [snapshotId, content] of ["", "ab", "abc"].entries()) {
      const state = await targetPlane.readSnapshot({ ...query, snapshotId });
      assert.ok(state);
      const page = await targetPlane.readContent({
        target,
        placement: query.placement,
        version: state.version,
      });
      expect(page.content).toBe(content);
    }
    expect(
      (
        await targetPlane.readEvents({
          ...query,
          version: head.version,
          startSeq: 0,
          endSeq: 2,
        })
      ).map((event) => event.eventId),
    ).toEqual(["event-0", "event-1", "event-2"]);
    expect((await targetPlane.readRuntimeFactHead(query)).headSeq).toBe(0);
    expect(
      (
        await targetPlane.readRuntimeFacts({
          ...query,
          headSeq: 0,
          afterSeq: -1,
          limit: 10,
        })
      ).facts[0].factId,
    ).toBe(
      (
        records.find((item) => item.kind === "runtime-fact") as Extract<
          BranchMigrationRecord,
          { kind: "runtime-fact" }
        >
      ).value.factId,
    );
    const memory = await targetPlane.queryNullMem({ ...query, limit: 10 });
    const rpc = new RpcBranchCommitStatePlane(() => ({
      append: (input) => branchStateRpcResult(() => targetPlane.append(input)),
      readHead: (input) =>
        branchStateRpcResult(() => targetPlane.readHead(input)),
      readContent: (input) =>
        branchStateRpcResult(() => targetPlane.readContent(input)),
      readEvents: (input) =>
        branchStateRpcResult(() => targetPlane.readEvents(input)),
      readRuntimeFacts: (input) =>
        branchStateRpcResult(() => targetPlane.readRuntimeFacts(input)),
      queryNullMem: (input) =>
        branchStateRpcResult(() => targetPlane.queryNullMem(input)),
    }));
    expect(
      (
        await rpc.readRuntimeFacts({
          ...query,
          headSeq: 0,
          afterSeq: -1,
          limit: 10,
        })
      ).facts,
    ).toEqual(
      records
        .filter((item) => item.kind === "runtime-fact")
        .map((item) => item.value),
    );
    expect(await rpc.queryNullMem({ ...query, limit: 10 })).toEqual(memory);
    expect(memory.memoryRevision).toBe(0);
    expect(() =>
      validateNullMemQueryResult(memory, { ...query, limit: 10 }),
    ).not.toThrow();
    expect(memory.records.map((record) => record.recordId)).toEqual([
      "memory-0",
    ]);
    expect(
      (
        await targetPlane.claimOutbox({
          leaseId: "migration-no-replay",
          now: 100,
          leaseMs: 1_000,
          limit: 10,
        })
      ).items,
    ).toHaveLength(0);
    const memoryWrite = await targetPlane.putNullMem({
      ...query,
      actorAccountId: "synthetic-owner",
      record: {
        version: 1,
        kind: "fact",
        ...target,
        recordId: "memory-1",
        createdAt: 20,
        text: "next",
      },
    });
    expect(memoryWrite.memoryRevision).toBe(1);
    expect(
      targetSql.rows(
        "SELECT 1 FROM branch_imported_outbox i JOIN branch_outbox_delivery d ON d.outbox_id=i.outbox_id",
      ),
    ).toHaveLength(0);
    expect(
      (await staging.activate(migrationId, manifest.generation, cert())).phase,
    ).toBe("activated");

    const next = {
      eventId: "event-3",
      seq: -1,
      dropId: target.rootDropId,
      sourceClientId: "state-plane",
      createdAt: 20,
      metadata: { followsSeq: 2 },
      ops: [{ type: "insert" as const, start: 3, end: 3, text: "!" }],
    };
    const nextIdentity = (await hashBranchBatchEvents([next]))[0];
    const result = await targetPlane.append({
      ...query,
      expected: head.version,
      event: next,
      payloadHash: nextIdentity.payloadHash,
    });
    expect(result.status).toBe("accepted");
    expect(
      (
        await targetPlane.readContent({
          target,
          placement: query.placement,
          version: result.receipt.version,
        })
      ).content,
    ).toBe("abc!");
    expect(() =>
      staging.rollback(migrationId, manifest.generation, cert()),
    ).toThrow("branch_initialization_conflict");
    targetSql.execute(
      "UPDATE branch_nullmem_import_baseline SET records_json='[]' WHERE root_drop_id=? AND branch_id=?",
      JSON.stringify(target.rootDropId),
      JSON.stringify(target.branchId),
    );
    await expect(
      targetPlane.queryNullMem({ ...query, limit: 10 }),
    ).rejects.toMatchObject({ code: "state_corrupt" });
    sourceSql.close();
    targetSql.close();
  });

  it("retries activation forward after atomic destination failure following source transfer", async () => {
    const sourceSql = new LocalBranchSqlite();
    const targetSql = new LocalBranchSqlite();
    const sourceFence = frozenSource(sourceSql);
    const { manifest, chunks } = await fixture();
    await SqliteBranchCommitStatePlane.create(targetSql);
    let fail = true;
    const faultPort: BranchSqlPort = {
      rows: <T extends Record<string, unknown>>(
        sql: string,
        ...values: BranchSqlValue[]
      ) => targetSql.rows<T>(sql, ...values),
      execute: (sql: string, ...values: BranchSqlValue[]) => {
        if (fail && sql.includes("INSERT INTO branch_events")) {
          fail = false;
          throw new Error("injected activation failure");
        }
        targetSql.execute(sql, ...values);
      },
      transaction: <T>(body: () => T) => targetSql.transaction(body),
    };
    const staging = new SqliteBranchMigrationStaging(
      faultPort,
      sourceFence,
      (value) => value.fence.sourceHeadHash === manifest.fence.sourceHeadHash,
    );
    staging.admit(manifest, cert());
    for (const chunk of chunks)
      await staging.putChunk(chunk, manifest.generation);
    await staging.verify(migrationId, manifest.generation, cert());
    await expect(
      staging.activate(migrationId, manifest.generation, cert()),
    ).rejects.toThrow("injected activation failure");
    expect(sourceFence.read(target).phase).toBe("transferred");
    expect(targetSql.rows("SELECT 1 FROM branch_heads")).toHaveLength(0);
    expect(() =>
      staging.rollback(migrationId, manifest.generation, cert()),
    ).toThrow("routing_placement_mismatch");
    const reopened = new SqliteBranchMigrationStaging(
      targetSql,
      sourceFence,
      (value) => value.fence.sourceHeadHash === manifest.fence.sourceHeadHash,
    );
    expect(
      (await reopened.activate(migrationId, manifest.generation, cert())).phase,
    ).toBe("activated");
    expect(
      (
        await (
          await SqliteBranchCommitStatePlane.create(targetSql)
        ).readHead({
          target,
          placement: { routingVersion: 1, generation: manifest.generation },
        })
      ).version.eventSeq,
    ).toBe(2);
    sourceSql.close();
    targetSql.close();
  });

  it("rejects tampered/incomplete chunks and pre-transfer rollback reopens source at a new generation", async () => {
    const sourceSql = new LocalBranchSqlite();
    const targetSql = new LocalBranchSqlite();
    const sourceFence = frozenSource(sourceSql);
    const { manifest, chunks } = await fixture();
    await SqliteBranchCommitStatePlane.create(targetSql);
    const staging = new SqliteBranchMigrationStaging(
      targetSql,
      sourceFence,
      (value) => value.fence.sourceHeadHash === manifest.fence.sourceHeadHash,
    );
    staging.admit(manifest, cert());
    await staging.putChunk(chunks[0], manifest.generation);
    await expect(
      staging.verify(migrationId, manifest.generation, cert()),
    ).rejects.toMatchObject({ code: "branch_initialization_pending" });
    const altered = {
      ...chunks[1],
      payload: [{ kind: "branch", value: {} }],
    } as BranchMigrationChunk;
    await expect(
      staging.putChunk(altered, manifest.generation),
    ).rejects.toThrow("branch_migration_chunk_hash_mismatch");
    const rolled = staging.rollback(migrationId, manifest.generation, cert());
    expect(rolled.phase).toBe("rolled-back");
    expect(rolled.generation).toBe(sourceGeneration + 1);
    expect(sourceFence.read(target)).toMatchObject({
      phase: "legacy",
      generation: 1,
      active: 0,
    });
    sourceSql.close();
    targetSql.close();
  });

  it("revalidates every staged byte before transfer and rejects a certificate scoped to another target", async () => {
    const sourceSql = new LocalBranchSqlite();
    const targetSql = new LocalBranchSqlite();
    const sourceFence = frozenSource(sourceSql);
    const { manifest, chunks } = await fixture();
    await SqliteBranchCommitStatePlane.create(targetSql);
    const staging = new SqliteBranchMigrationStaging(
      targetSql,
      sourceFence,
      (value) => value.fence.sourceHeadHash === manifest.fence.sourceHeadHash,
    );
    staging.admit(manifest, cert());
    for (const chunk of chunks)
      await staging.putChunk(chunk, manifest.generation);
    await staging.verify(migrationId, manifest.generation, cert());
    const tampered = String(
      targetSql.rows<{ payload_json: string }>(
        "SELECT payload_json FROM branch_migration_chunks WHERE migration_id=? AND chunk_index=0",
        migrationId,
      )[0].payload_json,
    ).replace("event-0", "event-9");
    targetSql.execute(
      "UPDATE branch_migration_chunks SET payload_json=? WHERE migration_id=? AND chunk_index=0",
      tampered,
      migrationId,
    );
    await expect(
      staging.activate(migrationId, manifest.generation, cert()),
    ).rejects.toMatchObject({ code: "state_corrupt" });
    expect(sourceFence.read(target).phase).toBe("frozen");
    expect(targetSql.rows("SELECT 1 FROM branch_heads")).toHaveLength(0);
    expect(() =>
      staging.rollback(migrationId, manifest.generation, {
        ...cert(),
        target: { ...target, rootDropId: "another-root" },
      }),
    ).toThrow("routing_placement_mismatch");
    sourceSql.close();
    targetSql.close();
  });

  it("excludes normal reservation on either side of migration admission and preflights target ownership before source transfer", async () => {
    const sourceSql = new LocalBranchSqlite();
    const targetSql = new LocalBranchSqlite();
    const sourceFence = frozenSource(sourceSql);
    const { manifest } = await fixture();
    const plane = await SqliteBranchCommitStatePlane.create(targetSql);
    const identity = {
      baseDropId: target.rootDropId,
      mode: "owner" as const,
      ownerAccountId: "synthetic-owner",
      writerAccountId: "synthetic-owner",
      writerClientId: null,
    };
    const staging = new SqliteBranchMigrationStaging(
      targetSql,
      sourceFence,
      (value) => value.fence.sourceHeadHash === manifest.fence.sourceHeadHash,
    );
    staging.admit(manifest, cert());
    await expect(
      plane.reserve({
        ...{
          target,
          placement: { routingVersion: 1, generation: manifest.generation },
        },
        reservationId: "normal",
        identity,
        rootRevision: "r",
      }),
    ).rejects.toMatchObject({ code: "branch_initialization_pending" });

    const occupiedSql = new LocalBranchSqlite();
    const occupiedPlane =
      await SqliteBranchCommitStatePlane.create(occupiedSql);
    await occupiedPlane.reserve({
      target,
      placement: { routingVersion: 1, generation: manifest.generation },
      reservationId: "normal-first",
      identity,
      rootRevision: "r",
    });
    const occupiedImporter = new SqliteBranchMigrationStaging(
      occupiedSql,
      sourceFence,
      (value) => value.fence.sourceHeadHash === manifest.fence.sourceHeadHash,
    );
    expect(() => occupiedImporter.admit(manifest, cert())).toThrow(
      "branch_initialization_conflict",
    );

    const racedSql = new LocalBranchSqlite();
    await SqliteBranchCommitStatePlane.create(racedSql);
    const racedImporter = new SqliteBranchMigrationStaging(
      racedSql,
      sourceFence,
      (value) => value.fence.sourceHeadHash === manifest.fence.sourceHeadHash,
    );
    racedImporter.admit(manifest, cert());
    for (const chunk of (await fixture()).chunks)
      await racedImporter.putChunk(chunk, manifest.generation);
    await racedImporter.verify(migrationId, manifest.generation, cert());
    racedSql.execute(
      "INSERT INTO branch_heads(root_drop_id,branch_id,routing_version,generation,head_json) VALUES(?,?,1,1,'{}')",
      JSON.stringify(target.rootDropId),
      JSON.stringify(target.branchId),
    );
    await expect(
      racedImporter.activate(migrationId, manifest.generation, cert()),
    ).rejects.toMatchObject({ code: "branch_initialization_conflict" });
    expect(sourceFence.read(target).phase).toBe("frozen");
    sourceSql.close();
    targetSql.close();
    occupiedSql.close();
    racedSql.close();
  });
});

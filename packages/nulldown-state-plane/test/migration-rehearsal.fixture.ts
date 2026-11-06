import { DurableObject } from "cloudflare:workers";
import { hashMigrationPayload } from "../../../shared/drop/branch-migration";
import type {
  BranchMigrationChunk,
  BranchMigrationManifest,
} from "../../../shared/drop/branch-migration";
import type { BranchStateTarget } from "../../../shared/drop/branch-state";
import { SqliteSourceWriteFence } from "../../../src/server/state-plane/source-fence";
import type { SourceFenceCertificate } from "../../../src/server/state-plane/source-fence";
import { SqliteBranchMigrationStaging } from "../../../src/server/state-plane/sqlite-migration";
import { initializeBranchSqlSchema } from "../../../src/server/state-plane/sqlite-schema";
import { DurableObjectBranchSqlite } from "../src/durable-object-sqlite";
import { branchStateShardName } from "../src/shard-router";
import {
  createCloudflareBlobStore,
  createCloudflareSqlStore,
} from "../../../functions/api/_lib/core/platform/cloudflare/storage";
import { captureLegacyMigrationSource } from "../../../src/server/state-plane/legacy-migration-source";
import { buildLegacyMigrationPayload } from "../../../src/server/state-plane/legacy-migration-payload";
import { createBranchRepository } from "../../../functions/api/_lib/branches/storage/repository";
import { appendEventsToBranch } from "../../../functions/api/_lib/nulledit/service";
import { createBranchRuntimeFactLogRepository } from "../../../functions/api/_lib/branches/storage/runtime-fact-log";
import { createSqlNullMemRecordStore } from "../../../src/server/stores/nullmem-record-store";
import { hashNulldownSourceContent } from "../../../shared/drop/resolved/hash";
import { SqliteBranchCommitStatePlane } from "../../../src/server/state-plane/sqlite-commits";
import { WriterApplicationRehearsal } from "./writer-application.fixture";

/** Synthetic-only DO harness: source gate and the real staging importer share one SQLite transaction domain. */
export class MigrationRehearsalObject extends DurableObject<MigrationRehearsalEnv> {
  readonly #env: MigrationRehearsalEnv;
  readonly #sql: DurableObjectBranchSqlite;
  readonly #fence: SqliteSourceWriteFence;
  readonly #staging: SqliteBranchMigrationStaging;
  readonly #application: WriterApplicationRehearsal;

  constructor(ctx: DurableObjectState, env: MigrationRehearsalEnv) {
    super(ctx, env);
    this.#env = env;
    this.#sql = new DurableObjectBranchSqlite(ctx.storage);
    initializeBranchSqlSchema(this.#sql);
    this.#fence = new SqliteSourceWriteFence(this.#sql);
    this.#application = new WriterApplicationRehearsal(this.#sql, this.#fence, {
      blobs: env.LEGACY_R2,
      db: env.LEGACY_D1,
      secret: env.MIGRATION_REHEARSAL_TOKEN ?? "",
      waitUntil: (task) => ctx.waitUntil(task),
    });
    this.#sql.execute(`CREATE TABLE IF NOT EXISTS rehearsal_certificates(
      migration_id TEXT PRIMARY KEY, manifest_json TEXT NOT NULL, certification TEXT NOT NULL)`);
    this.#sql.execute(`CREATE TABLE IF NOT EXISTS rehearsal_payload_chunks(
      migration_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, chunk_json TEXT NOT NULL,
      PRIMARY KEY(migration_id,chunk_index))`);
    this.#sql.execute(
      "CREATE TABLE IF NOT EXISTS rehearsal_post_activation(migration_id TEXT PRIMARY KEY,result_json TEXT NOT NULL)",
    );
    this.#sql.execute(
      "CREATE TABLE IF NOT EXISTS rehearsal_abort_results(migration_id TEXT PRIMARY KEY,result_json TEXT NOT NULL)",
    );
    this.#staging = new SqliteBranchMigrationStaging(
      this.#sql,
      this.#fence,
      (manifest, certificate) => {
        const row = this.#sql.rows<{
          manifest_json: string;
          certification: string;
        }>(
          "SELECT manifest_json,certification FROM rehearsal_certificates WHERE migration_id=?",
          manifest.migrationId,
        )[0];
        return Boolean(
          row &&
          row.manifest_json === JSON.stringify(manifest) &&
          row.certification === manifest.fence.certification &&
          certificate.migrationId === manifest.migrationId &&
          certificate.sourceGeneration === manifest.fence.sourceGeneration,
        );
      },
    );
  }

  /** Seeds only deterministic synthetic legacy data through the actual R2/D1 repositories under a durable permit. */
  async seedSource(target: BranchStateTarget, migrationId: string) {
    this.#assertTarget(target);
    this.#assertMigration(migrationId);
    const certificate: SourceFenceCertificate = {
      target,
      sourceGeneration: 0,
      migrationId,
    };
    let gate;
    try {
      gate = this.#fence.read(target);
    } catch {
      gate = this.#fence.register(target);
    }
    if (
      (gate.phase === "frozen" || gate.phase === "transferred") &&
      gate.migrationId === migrationId
    )
      return { seeded: false, phase: gate.phase };
    if (
      gate.phase === "legacy" &&
      gate.generation === 1 &&
      gate.migrationId === null
    )
      return { seeded: false, phase: gate.phase, generation: gate.generation };
    if (gate.phase !== "legacy" || gate.generation !== 0)
      throw Error("rehearsal_source_not_writable");
    const permit = this.#fence.admit({
      target,
      generation: 0,
      requestId: `seed-${migrationId}`,
    });
    const blobs = createCloudflareBlobStore(
      this.#env.LEGACY_R2 as Parameters<typeof createCloudflareBlobStore>[0],
    );
    const sql = createCloudflareSqlStore(this.#env.LEGACY_D1);
    if (!sql) throw Error("rehearsal_sql_unavailable");
    const repository = createBranchRepository({ blobs });
    if (await repository.readBranch(target.rootDropId, target.branchId))
      throw Error("rehearsal_source_already_exists");
    const content = "";
    const branch = {
      version: 1 as const,
      ...target,
      baseDropId: target.rootDropId,
      mode: "owner" as const,
      status: "active" as const,
      ownerAccountId: "rehearsal-owner",
      writerAccountId: "rehearsal-writer",
      writerClientId: null,
      headSnapshotId: 0,
      headEventSeq: -1,
      snapshotHeapVersion: 2,
      checkpointInterval: 24,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    };
    const snapshot = {
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
      sourceContentHash: await hashNulldownSourceContent(content),
      createdAt: branch.createdAt,
    };
    await repository.writeBranch(branch);
    await repository.writeSnapshot(snapshot);
    await repository.writeSnapshotCheckpoint(
      target.rootDropId,
      target.branchId,
      0,
      content,
    );
    await repository.writeBranchDiffLog(target.rootDropId, target.branchId, []);
    const event = (
      eventId: string,
      text: string,
      seq: number,
      start: number,
    ) => ({
      eventId,
      seq,
      dropId: target.rootDropId,
      sourceClientId: "rehearsal-client",
      createdAt: branch.createdAt + seq + 1,
      ops: [{ type: "insert" as const, start, end: start, text }],
      metadata: { followsSeq: seq - 1 },
    });
    const batch = await appendEventsToBranch(blobs, branch, [
      event("source-batch-1", "a", 0, 0),
      event("source-batch-2", "b", 1, 1),
    ]);
    const single = await appendEventsToBranch(blobs, batch.branch, [
      event("source-single-3", "c", 2, 2),
    ]);
    const fact = {
      version: 1 as const,
      kind: "ui.state.patch" as const,
      id: "rehearsal-runtime",
      callId: "rehearsal-call",
      createdAt: branch.createdAt + 100,
      source: {
        ...target,
        sourceContentHash: await hashNulldownSourceContent(""),
        snapshotId: 0,
      },
      patch: [{ op: "set" as const, path: ["rehearsal"], value: true }],
    };
    await createBranchRuntimeFactLogRepository({
      blobs,
    }).appendBranchRuntimeFact(target.rootDropId, target.branchId, fact);
    const memories = createSqlNullMemRecordStore(sql);
    await memories.put({
      version: 1,
      kind: "fact",
      recordId: "rehearsal-fact",
      ...target,
      text: "imported fact",
      createdAt: branch.createdAt + 200,
    });
    await memories.put({
      version: 1,
      kind: "procedure",
      recordId: "rehearsal-procedure",
      ...target,
      goal: "exercise migration",
      summary: "Native rehearsal procedure",
      steps: [
        { index: 0, kind: "test", name: "capture legacy", status: "success" },
        { index: 1, kind: "test", name: "activate import", status: "success" },
      ],
      outcome: "success",
      createdAt: branch.createdAt + 201,
    });
    this.#fence.complete(permit);
    const uncertain = this.#fence.admit({
      target,
      generation: 0,
      requestId: `uncertain-${migrationId}`,
    });
    const draining = this.#fence.fence(certificate);
    if (draining.phase !== "draining")
      throw Error("rehearsal_uncertain_admission_not_draining");
    this.#fence.complete(uncertain);
    this.#fence.fence(certificate);
    return {
      seeded: true,
      phase: this.#fence.read(target).phase,
      headSnapshotId: single.branch.headSnapshotId,
    };
  }

  /** Captures configured R2/D1 under the frozen source gate; requests cannot supply manifests or history. */
  async prepareImport(
    target: BranchStateTarget,
    sourceGeneration: number,
    migrationId: string,
  ) {
    this.#assertTarget(target);
    this.#assertMigration(migrationId);
    const certificate: SourceFenceCertificate = {
      target,
      sourceGeneration,
      migrationId,
    };
    const prior = this.#sql.rows<{
      manifest_json: string;
      certification: string;
    }>(
      "SELECT manifest_json,certification FROM rehearsal_certificates WHERE migration_id=?",
      migrationId,
    )[0];
    if (prior) {
      const manifest = JSON.parse(
        prior.manifest_json,
      ) as BranchMigrationManifest;
      if (
        JSON.stringify(manifest) !== prior.manifest_json ||
        manifest.target.rootDropId !== target.rootDropId ||
        manifest.target.branchId !== target.branchId ||
        manifest.fence.sourceGeneration !== sourceGeneration ||
        manifest.migrationId !== migrationId ||
        manifest.fence.certification !== prior.certification
      )
        throw Error("rehearsal_manifest_corrupt");
      const state = this.#fence.read(target);
      if (
        state.migrationId !== migrationId ||
        state.generation !== sourceGeneration ||
        !["frozen", "transferred"].includes(state.phase)
      )
        throw Error("routing_placement_mismatch");
      let progress;
      try {
        progress = this.#staging.getProgress(migrationId);
      } catch {
        if (state.phase !== "frozen")
          throw Error("branch_migration_recovery_required");
        progress = this.#staging.admit(manifest, certificate);
      }
      if (state.phase === "frozen" && progress.phase === "importing")
        this.#staging.admit(manifest, certificate);
      const chunks = this.#sql
        .rows<{ chunk_json: string }>(
          "SELECT chunk_json FROM rehearsal_payload_chunks WHERE migration_id=? ORDER BY chunk_index",
          migrationId,
        )
        .map((row) => JSON.parse(row.chunk_json) as BranchMigrationChunk);
      return {
        manifest,
        chunkCount: chunks.length,
        progress,
        captureHash: manifest.fence.sourceHeadHash,
        eventIds: chunks.flatMap((chunk) =>
          chunk.payload
            .filter((record) => record.kind === "event")
            .map((record) => record.value.event.eventId),
        ),
        runtimeFactCount: chunks.reduce(
          (n, chunk) =>
            n +
            chunk.payload.filter((record) => record.kind === "runtime-fact")
              .length,
          0,
        ),
        memoryIds: chunks
          .flatMap((chunk) =>
            chunk.payload
              .filter((record) => record.kind === "nullmem")
              .flatMap((record) =>
                record.value.records.map((memory) => memory.recordId),
              ),
          )
          .sort(),
      };
    }
    this.#fence.assertFrozen(certificate);
    const blobs = createCloudflareBlobStore(
      this.#env.LEGACY_R2 as Parameters<typeof createCloudflareBlobStore>[0],
    );
    const sql = createCloudflareSqlStore(this.#env.LEGACY_D1);
    if (!sql) throw Error("rehearsal_sql_unavailable");
    const fence = this.#fence;
    const captured = await captureLegacyMigrationSource({
      blobs,
      sql,
      target,
      async assertFrozen() {
        fence.assertFrozen(certificate);
      },
    });
    const certification = `trusted-${captured.captureHash.slice("sha256:".length)}`;
    const payload = await buildLegacyMigrationPayload(captured, {
      migrationId,
      sourceId: `legacy-${target.rootDropId}`,
      sourceGeneration,
      certification,
    });
    // Two independently persisted chunks make a partial-import restart observable.
    const records = payload.chunks.flatMap((chunk) => chunk.payload);
    const middle = Math.ceil(records.length / 2);
    payload.chunks = await Promise.all(
      [records.slice(0, middle), records.slice(middle)].map(
        async (payload, index) => ({
          migrationId,
          index,
          payload,
          payloadHash: await hashMigrationPayload(payload),
        }),
      ),
    );
    payload.manifest.chunkCount = payload.chunks.length;
    payload.manifest.payloadHash = await hashMigrationPayload(
      payload.chunks.map((chunk) => chunk.payloadHash),
    );
    const manifestJson = JSON.stringify(payload.manifest);
    this.#sql.transaction(() => {
      const prior = this.#sql.rows<{ manifest_json: string }>(
        "SELECT manifest_json FROM rehearsal_certificates WHERE migration_id=?",
        migrationId,
      )[0];
      if (prior && prior.manifest_json !== manifestJson)
        throw Error("rehearsal_manifest_conflict");
      if (!prior)
        this.#sql.execute(
          "INSERT INTO rehearsal_certificates(migration_id,manifest_json,certification) VALUES(?,?,?)",
          migrationId,
          manifestJson,
          certification,
        );
      for (const chunk of payload.chunks) {
        const json = JSON.stringify(chunk);
        const stored = this.#sql.rows<{ chunk_json: string }>(
          "SELECT chunk_json FROM rehearsal_payload_chunks WHERE migration_id=? AND chunk_index=?",
          migrationId,
          chunk.index,
        )[0];
        if (stored && stored.chunk_json !== json)
          throw Error("rehearsal_chunk_conflict");
        if (!stored)
          this.#sql.execute(
            "INSERT INTO rehearsal_payload_chunks(migration_id,chunk_index,chunk_json) VALUES(?,?,?)",
            migrationId,
            chunk.index,
            json,
          );
      }
    });
    const progress = this.#staging.admit(payload.manifest, certificate);
    return {
      manifest: payload.manifest,
      chunkCount: payload.chunks.length,
      progress,
      captureHash: captured.captureHash,
      eventIds: captured.events.map((event) => event.eventId),
      runtimeFactCount: captured.runtimeFacts.length,
      memoryIds: captured.memoryRecords.map((record) => record.recordId).sort(),
    };
  }

  /** Retrieves one worker-generated persisted source chunk for restart-safe bounded drivers. */
  preparedChunk(migrationId: string, index: number) {
    this.#assertMigration(migrationId);
    if (!Number.isSafeInteger(index) || index < 0)
      throw Error("invalid_command");
    const row = this.#sql.rows<{ chunk_json: string }>(
      "SELECT chunk_json FROM rehearsal_payload_chunks WHERE migration_id=? AND chunk_index=?",
      migrationId,
      index,
    )[0];
    if (!row) throw Error("branch_not_found");
    return JSON.parse(row.chunk_json) as BranchMigrationChunk;
  }

  /** Persists one immutable chunk via the production staging importer. */
  putChunk(chunk: BranchMigrationChunk, generation: number) {
    this.#assertMigration(chunk.migrationId);
    return this.#staging.putChunk(chunk, generation);
  }
  /** Revalidates all chunks while the durable synthetic source gate remains frozen. */
  verify(id: string, generation: number, certificate: SourceFenceCertificate) {
    this.#assertMigration(id);
    this.#assertTrustedCertificate(id, certificate);
    return this.#staging.verify(id, generation, certificate);
  }
  /** Transfer/activation requires exact persisted manifest certification, not request-only strings. */
  activate(
    id: string,
    generation: number,
    certificate: SourceFenceCertificate,
  ) {
    this.#assertMigration(id);
    this.#assertTrustedCertificate(id, certificate);
    return this.#staging.activate(id, generation, certificate);
  }
  /** Aborts only before irreversible source transfer. */
  rollback(
    id: string,
    generation: number,
    certificate: SourceFenceCertificate,
  ) {
    this.#assertMigration(id);
    this.#assertTrustedCertificate(id, certificate);
    return this.#staging.rollback(id, generation, certificate);
  }
  /** Models a lost activation response after the trusted source gate has irreversibly transferred. */
  transferSource(id: string, certificate: SourceFenceCertificate) {
    this.#assertMigration(id);
    this.#assertTrustedCertificate(id, certificate);
    if (
      !["verified", "activated"].includes(this.#staging.getProgress(id).phase)
    )
      throw Error("branch_initialization_pending");
    return this.#fence.transfer(certificate);
  }
  /** Proves abort reopened legacy admission at its incremented generation with a real append. */
  async legacyWriteAfterAbort(target: BranchStateTarget, migrationId: string) {
    this.#assertTarget(target);
    this.#assertMigration(migrationId);
    const saved = this.#sql.rows<{ result_json: string }>(
      "SELECT result_json FROM rehearsal_abort_results WHERE migration_id=?",
      migrationId,
    )[0];
    if (saved) return JSON.parse(saved.result_json);
    const gate = this.#fence.read(target);
    if (
      gate.phase !== "legacy" ||
      gate.generation !== 1 ||
      gate.migrationId !== null
    )
      throw Error("routing_placement_mismatch");
    const permit = this.#fence.admit({
      target,
      generation: 1,
      requestId: `post-abort-${migrationId}`,
    });
    const blobs = createCloudflareBlobStore(
      this.#env.LEGACY_R2 as Parameters<typeof createCloudflareBlobStore>[0],
    );
    const repository = createBranchRepository({ blobs });
    const branch = await repository.readBranch(
      target.rootDropId,
      target.branchId,
    );
    if (!branch) throw Error("branch_not_found");
    const event = {
      eventId: `${migrationId}-legacy-after-abort`,
      seq: -1,
      dropId: target.rootDropId,
      sourceClientId: "reopened-legacy-writer",
      createdAt: 1_900_000_000_001,
      ops: [{ type: "insert" as const, start: 3, end: 3, text: "!" }],
    };
    const appended = await appendEventsToBranch(blobs, branch, [event]);
    this.#fence.complete(permit);
    const result = {
      phase: this.#fence.read(target).phase,
      generation: this.#fence.read(target).generation,
      eventId: appended.acknowledgements[0]?.eventId,
      content: appended.content,
    };
    this.#sql.transaction(() =>
      this.#sql.execute(
        "INSERT INTO rehearsal_abort_results(migration_id,result_json) VALUES(?,?)",
        migrationId,
        JSON.stringify(result),
      ),
    );
    return result;
  }
  /** Attempts a real generation-zero admission/append to prove stale writers are fenced. */
  staleWriter(target: BranchStateTarget, destination: boolean) {
    this.#assertTarget(target);
    if (!destination)
      return this.#fence.admit({
        target,
        generation: 0,
        requestId: "stale-source-writer",
      });
    return new SqliteBranchCommitStatePlane(this.#sql).appendBatch({
      target,
      placement: { routingVersion: 1, generation: 0 },
      events: [
        {
          eventId: "stale-destination-writer",
          seq: -1,
          dropId: target.rootDropId,
          sourceClientId: "stale-writer",
          createdAt: 1_800_000_000_005,
          ops: [{ type: "insert", start: 0, end: 0, text: "stale" }],
        },
      ],
    });
  }
  /** Returns durable import phase for crash/restart assertions. */
  progress(id: string) {
    this.#assertMigration(id);
    return this.#staging.getProgress(id);
  }
  /** Applies real document/runtime/memory writes once; the durable result supports restart comparison. */
  async postActivationWrites(target: BranchStateTarget, migrationId: string) {
    this.#assertTarget(target);
    this.#assertMigration(migrationId);
    const saved = this.#sql.rows<{ result_json: string }>(
      "SELECT result_json FROM rehearsal_post_activation WHERE migration_id=?",
      migrationId,
    )[0];
    if (saved) return JSON.parse(saved.result_json);
    if (this.#staging.getProgress(migrationId).phase !== "activated")
      throw Error("branch_initialization_pending");
    const manifest = JSON.parse(
      this.#sql.rows<{ manifest_json: string }>(
        "SELECT manifest_json FROM rehearsal_certificates WHERE migration_id=?",
        migrationId,
      )[0].manifest_json,
    ) as BranchMigrationManifest;
    const plane = new SqliteBranchCommitStatePlane(this.#sql);
    const query = {
      target,
      placement: {
        routingVersion: 1 as const,
        generation: manifest.generation,
      },
    };
    const events = [
      {
        eventId: `${migrationId}-native-batch-a`,
        seq: -1,
        dropId: target.rootDropId,
        sourceClientId: "native-rehearsal",
        createdAt: 1_800_000_000_001,
        metadata: { followsSeq: 2 },
        ops: [{ type: "insert" as const, start: 3, end: 3, text: "!" }],
      },
      {
        eventId: `${migrationId}-native-batch-b`,
        seq: -1,
        dropId: target.rootDropId,
        sourceClientId: "native-rehearsal",
        createdAt: 1_800_000_000_002,
        metadata: { followsSeq: 3 },
        ops: [{ type: "insert" as const, start: 4, end: 4, text: "?" }],
      },
    ];
    const batch = await plane.appendBatch({ ...query, events });
    const runtime = await plane.appendRuntimeFact({
      ...query,
      actorAccountId: "rehearsal-writer",
      fact: {
        version: 1,
        kind: "ui.state.patch",
        id: `${migrationId}-native-runtime`,
        callId: `${migrationId}-native-call`,
        createdAt: 1_800_000_000_003,
        source: {
          ...target,
          snapshotId: batch.branch.headSnapshotId,
          sourceContentHash: await hashNulldownSourceContent(batch.content),
        },
        patch: [
          { op: "set", path: ["native", "forwardRecovered"], value: true },
        ],
      },
    });
    const memoryId = `${migrationId}-native-memory`;
    const memory = await plane.putNullMem({
      ...query,
      actorAccountId: "rehearsal-writer",
      record: {
        version: 1,
        kind: "fact",
        recordId: memoryId,
        ...target,
        text: "forward recovery retained this memory",
        createdAt: 1_800_000_000_004,
      },
    });
    const result = {
      content: batch.content,
      eventIds: events.map((event) => event.eventId),
      runtimeId: runtime.receipt.event.factId,
      memoryRevision: memory.memoryRevision,
      memoryId,
    };
    this.#sql.transaction(() =>
      this.#sql.execute(
        "INSERT INTO rehearsal_post_activation(migration_id,result_json) VALUES(?,?)",
        migrationId,
        JSON.stringify(result),
      ),
    );
    return result;
  }
  /** Reads canonical active branch, runtime, NullMem and original source acknowledgements. */
  async readback(target: BranchStateTarget, migrationId: string) {
    this.#assertTarget(target);
    this.#assertMigration(migrationId);
    const manifest = JSON.parse(
      this.#sql.rows<{ manifest_json: string }>(
        "SELECT manifest_json FROM rehearsal_certificates WHERE migration_id=?",
        migrationId,
      )[0].manifest_json,
    ) as BranchMigrationManifest;
    const plane = new SqliteBranchCommitStatePlane(this.#sql);
    const query = {
      target,
      placement: {
        routingVersion: 1 as const,
        generation: manifest.generation,
      },
    };
    const head = await plane.readHead(query);
    const content = await plane.readContent({
      ...query,
      version: head.version,
    });
    const runtimeHead = await plane.readRuntimeFactHead(query);
    const runtime = await plane.readRuntimeFacts({
      ...query,
      headSeq: runtimeHead.headSeq,
      afterSeq: -1,
      limit: 100,
    });
    const memory = await plane.queryNullMem({ ...query, limit: 100 });
    const events = await plane.readEvents({
      ...query,
      version: head.version,
      startSeq: 0,
      endSeq: head.version.eventSeq,
    });
    const acknowledgements = this.#sql
      .rows<{ event_id: string; acknowledgement_json: string }>(
        "SELECT event_id,acknowledgement_json FROM branch_migration_public_acks WHERE migration_id=? ORDER BY event_id",
        migrationId,
      )
      .map((row) => ({
        eventId: JSON.parse(row.event_id) as string,
        acknowledgement: JSON.parse(row.acknowledgement_json),
      }));
    const importedSnapshots = [];
    const snapshotIds = this.#sql
      .rows<{ chunk_json: string }>(
        "SELECT chunk_json FROM rehearsal_payload_chunks WHERE migration_id=? ORDER BY chunk_index",
        migrationId,
      )
      .flatMap(
        (row) => (JSON.parse(row.chunk_json) as BranchMigrationChunk).payload,
      )
      .filter((record) => record.kind === "snapshot")
      .map((record) => record.value.snapshot.snapshotId)
      .sort((a, b) => a - b);
    for (const snapshotId of snapshotIds) {
      const discovered = await plane.readSnapshot({ ...query, snapshotId });
      if (!discovered) throw Error("state_corrupt");
      const content = await plane.readContent({
        ...query,
        version: discovered.version,
      });
      importedSnapshots.push({
        snapshot: discovered.snapshot,
        content: content.content,
      });
    }
    return {
      phase: this.#staging.getProgress(migrationId).phase,
      head: head.version,
      content: content.content,
      eventIds: events.map((event) => event.eventId),
      runtimeIds: runtime.facts.map((event) => event.factId),
      memoryRevision: memory.memoryRevision,
      memoryIds: memory.records.map((record) => record.recordId).sort(),
      acknowledgements,
      importedSnapshots,
      events,
      runtimeFacts: runtime.facts,
      memoryRecords: memory.records,
    };
  }
  /** Synthetic-fixture health endpoint only; no public production API is added. */
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 404 });
    let actionName = "unknown";
    let requestId = "untracked";
    try {
      const input = (await readBoundedJson(request)) as {
        action: string;
        [key: string]: unknown;
      };
      this.#assertTarget(input.target as BranchStateTarget);
      const runId = (input.target as BranchStateTarget).rootDropId.slice(
        "MigrationRehearsal-".length,
      );
      const expectedMigration = `migration-rehearsal-${runId}`;
      if (
        input.migrationId !== undefined &&
        input.migrationId !== expectedMigration
      )
        throw Error("rehearsal_scope_denied");
      if (
        input.chunk &&
        (input.chunk as BranchMigrationChunk).migrationId !== expectedMigration
      )
        throw Error("rehearsal_scope_denied");
      if (input.certificate) {
        const certificate = input.certificate as SourceFenceCertificate;
        if (
          certificate.migrationId !== expectedMigration ||
          certificate.target.rootDropId !==
            (input.target as BranchStateTarget).rootDropId ||
          certificate.target.branchId !==
            (input.target as BranchStateTarget).branchId
        )
          throw Error("rehearsal_scope_denied");
      }
      requestId =
        typeof input.requestId === "string" &&
        /^[A-Za-z0-9_-]{1,80}$/.test(input.requestId)
          ? input.requestId
          : "untracked";
      actionName = /^[A-Za-z-]{1,32}$/.test(input.action)
        ? input.action
        : "unknown";
      const actions: Record<string, () => unknown> = {
        registerApplication: () =>
          this.#application.register(input.target as BranchStateTarget),
        applicationRequest: () =>
          this.#application.request(input.target as BranchStateTarget, {
            path: input.path,
            method: input.method,
            body: input.body,
            requestId: input.requestId,
            generation: input.generation,
          }),
        destinationRequest: () => {
          if (
            this.#staging.getProgress(expectedMigration).phase !== "activated"
          )
            throw Error("branch_initialization_pending");
          return this.#application.request(
            input.target as BranchStateTarget,
            {
              path: input.path,
              method: input.method,
              body: input.body,
              requestId: input.requestId,
            },
            true,
          );
        },
        applicationFault: () =>
          this.#application.fault(
            input.target as BranchStateTarget,
            input.fault,
          ),
        applicationRelease: () =>
          this.#application.release(input.target as BranchStateTarget),
        reconcileApplication: () =>
          this.#application.reconcile(input.target as BranchStateTarget),
        sourceState: () => this.#fence.read(input.target as BranchStateTarget),
        sourceFence: () =>
          this.#fence.fence(input.certificate as SourceFenceCertificate),
        staleWriter: () =>
          this.staleWriter(
            input.target as BranchStateTarget,
            input.destination === true,
          ),
        seedSource: () =>
          this.seedSource(
            input.target as BranchStateTarget,
            String(input.migrationId),
          ),
        prepareImport: () =>
          this.prepareImport(
            input.target as BranchStateTarget,
            Number(input.sourceGeneration),
            String(input.migrationId),
          ),
        preparedChunk: () =>
          this.preparedChunk(String(input.migrationId), Number(input.index)),
        putChunk: () =>
          this.putChunk(
            input.chunk as BranchMigrationChunk,
            Number(input.generation),
          ),
        verify: () =>
          this.verify(
            String(input.migrationId),
            Number(input.generation),
            input.certificate as SourceFenceCertificate,
          ),
        activate: () =>
          this.activate(
            String(input.migrationId),
            Number(input.generation),
            input.certificate as SourceFenceCertificate,
          ),
        rollback: () =>
          this.rollback(
            String(input.migrationId),
            Number(input.generation),
            input.certificate as SourceFenceCertificate,
          ),
        transferSource: () =>
          this.transferSource(
            String(input.migrationId),
            input.certificate as SourceFenceCertificate,
          ),
        legacyWriteAfterAbort: () =>
          this.legacyWriteAfterAbort(
            input.target as BranchStateTarget,
            String(input.migrationId),
          ),
        progress: () => this.progress(String(input.migrationId)),
        postActivationWrites: () =>
          this.postActivationWrites(
            input.target as BranchStateTarget,
            String(input.migrationId),
          ),
        readback: () =>
          this.readback(
            input.target as BranchStateTarget,
            String(input.migrationId),
          ),
      };
      if (!Object.hasOwn(actions, input.action))
        return Response.json(
          { error: "invalid_action", requestId },
          { status: 400 },
        );
      const value = await actions[input.action]();
      emit({
        event: "state_plane.migration_rehearsal.action",
        version: 1,
        outcome: "accepted",
        reason: "completed",
        action: input.action,
        requestId,
      });
      return Response.json(
        { value, requestId },
        { headers: { "x-request-id": requestId } },
      );
    } catch (error) {
      const rawCode =
        error &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : error instanceof Error
            ? error.message
            : "fixture_failure";
      const code = /^[a-z0-9_.-]{1,80}$/.test(rawCode)
        ? rawCode
        : rawCode
            .toLowerCase()
            .replace(/[^a-z0-9_.-]+/g, "_")
            .slice(0, 80) || "fixture_failure";
      const kind =
        error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name)
          ? error.name.toLowerCase()
          : "unknown";
      emit({
        event: "state_plane.migration_rehearsal.action",
        version: 1,
        outcome: "rejected",
        reason: code,
        kind,
        action: actionName,
        requestId,
      });
      return Response.json(
        { error: code, kind, requestId },
        { status: 409, headers: { "x-request-id": requestId } },
      );
    }
  }

  #assertTarget(target: BranchStateTarget) {
    if (
      !target ||
      !/^MigrationRehearsal-[A-Za-z0-9_-]{1,32}$/.test(target.rootDropId) ||
      (target.branchId !== "owner" &&
        target.branchId !==
          `writer-${target.rootDropId.slice("MigrationRehearsal-".length)}`)
    )
      throw Error("rehearsal_scope_denied");
  }
  #assertMigration(id: string) {
    if (!/^migration-rehearsal-[A-Za-z0-9_-]{1,32}$/.test(id))
      throw Error("rehearsal_scope_denied");
  }
  #assertTrustedCertificate(id: string, certificate: SourceFenceCertificate) {
    this.#assertTarget(certificate.target);
    const row = this.#sql.rows<{
      manifest_json: string;
      certification: string;
    }>(
      "SELECT manifest_json,certification FROM rehearsal_certificates WHERE migration_id=?",
      id,
    )[0];
    if (!row) throw Error("rehearsal_certificate_missing");
    const manifest = JSON.parse(row.manifest_json) as BranchMigrationManifest;
    if (
      manifest.fence.certification !== row.certification ||
      manifest.fence.sourceGeneration !== certificate.sourceGeneration ||
      manifest.target.rootDropId !== certificate.target.rootDropId ||
      manifest.target.branchId !== certificate.target.branchId ||
      manifest.migrationId !== certificate.migrationId
    )
      throw Error("rehearsal_certificate_mismatch");
  }
}

/** Deployment bindings plus the secret injected into the isolated rehearsal Worker. */
export type MigrationRehearsalEnv = MigrationRehearsalBindings & {
  MIGRATION_REHEARSAL_TOKEN?: string;
};

async function authorized(
  request: Request,
  expected: string | undefined,
): Promise<boolean> {
  const supplied =
    request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!expected || !supplied || supplied.length > 512) return false;
  const encoder = new TextEncoder();
  const digest = async (value: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    );
  const [left, right] = await Promise.all([digest(supplied), digest(expected)]);
  return crypto.subtle.timingSafeEqual(left, right);
}

function emit(event: Record<string, string | number>): void {
  try {
    console.log(JSON.stringify(event));
  } catch {
    /* telemetry cannot alter fixture outcomes */
  }
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > 1_000_000) throw Error("request_too_large");
  const reader = request.body?.getReader();
  if (!reader) throw Error("invalid_request");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 1_000_000) {
      await reader.cancel();
      throw Error("request_too_large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body),
  );
}

/** Private staging-only Worker; run identity follows the frozen fixed-16 shard router. */
export default {
  async fetch(request: Request, env: MigrationRehearsalEnv): Promise<Response> {
    if (!(await authorized(request, env.MIGRATION_REHEARSAL_TOKEN)))
      return new Response(null, { status: 404 });
    let body: unknown;
    try {
      body = await readBoundedJson(request.clone());
    } catch {
      return new Response(null, { status: 400 });
    }
    if (!body || typeof body !== "object" || !("target" in body))
      return new Response(null, { status: 400 });
    const target = (body as { target?: BranchStateTarget }).target;
    if (
      !target ||
      !/^MigrationRehearsal-[A-Za-z0-9_-]{1,32}$/.test(target.rootDropId) ||
      (target.branchId !== "owner" &&
        target.branchId !==
          `writer-${target.rootDropId.slice("MigrationRehearsal-".length)}`)
    )
      return new Response(null, { status: 400 });
    const shard = await branchStateShardName({
      target,
      placement: { routingVersion: 1, generation: 0 },
    });
    return env.REHEARSAL.getByName(shard).fetch(request);
  },
};

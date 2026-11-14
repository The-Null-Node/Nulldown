import { hashBranchBatchEvents } from "../../../shared/drop/branch-batch";
import {
  isDropBranchRecord,
  isDropSnapshotRecord,
} from "../../../shared/drop/branch";
import {
  validateNullMemRecord,
  nullMemRecordIdentity,
} from "../../../shared/drop/branch-nullmem";
import { DropDiffOperation } from "../../../shared/drop/diff-operation";
import {
  isDropDiffEvent,
  isDropBranchRuntimeFact,
} from "../../../shared/drop/diff";
import { hashNulldownSourceContent } from "../../../shared/drop/resolved/hash";
import {
  prepareBranchInitialization,
  type BranchAuthorityRecord,
  type BranchInitializeRecord,
  type BranchInitializationReceipt,
} from "../../../shared/drop/branch-lifecycle";
import {
  BranchStateError,
  type BranchStateHead,
  type BranchCommitReceipt,
  type BranchStateVersion,
} from "../../../shared/drop/branch-state";
import {
  runtimeFactIdentity,
  runtimeFactIntent,
  runtimeFactKey,
  runtimeFactOutbox,
  hashRuntimeFactIntent,
  validateRuntimeFactEvent,
  type BranchRuntimeFactReceipt,
} from "../../../shared/drop/branch-runtime-facts";
import type { BranchNullMemRecord } from "../../../shared/drop/branch-nullmem";
import { applyDiff } from "../../../shared/nulledit/textDiff";
import { DiffOp } from "../../../shared/nulledit/types";
import {
  captureBranchMigrationChunk,
  captureBranchMigrationManifest,
  hashMigrationPayload,
  migrationChunkBytes,
  type BranchMigrationChunk,
  type BranchMigrationManifest,
  type BranchMigrationProgress,
  type BranchMigrationRecord,
} from "../../../shared/drop/branch-migration";
import { serializeCanonicalJson } from "../../../shared/drop/types";
import type {
  SqliteSourceWriteFence,
  SourceFenceCertificate,
} from "./source-fence";
import { encodeBranchSqlText } from "./sqlite-schema";
import type { BranchSqlPort } from "./sqlite-port";

type Row = Record<string, unknown>;
const reject = (code: BranchStateError["code"]): never => {
  throw new BranchStateError(code);
};
const sqlScope = (target: { rootDropId: string; branchId: string }) => [
  encodeBranchSqlText(target.rootDropId),
  encodeBranchSqlText(target.branchId),
];

/** Imports certified legacy snapshots and histories directly into authoritative SQLite tables. */
export class SqliteBranchMigrationStaging {
  constructor(
    private readonly sql: BranchSqlPort,
    private readonly sourceFence: SqliteSourceWriteFence,
    /** Binds the frozen capture hash/revision to metadata held by the trusted source DO. */
    private readonly verifySourceCommitment: (
      manifest: BranchMigrationManifest,
      certificate: SourceFenceCertificate,
    ) => boolean,
  ) {}

  /** Reads durable status for bounded recovery and isolated native rehearsals. */
  getProgress(migrationId: string): BranchMigrationProgress {
    const { manifest, row } = this.load(migrationId);
    return this.progress(manifest, row);
  }

  /** Admits one manifest only while the source gate is drained and frozen. */
  admit(
    input: BranchMigrationManifest,
    certificate: SourceFenceCertificate,
  ): BranchMigrationProgress {
    const manifest = captureBranchMigrationManifest(input);
    this.assertCertificate(manifest, certificate, "frozen");
    this.sourceFence.assertFrozen(certificate);
    return this.sql.transaction(() => {
      const existing = this.sql.rows<Row>(
        "SELECT manifest_json,phase,next_chunk,item_count FROM branch_migrations WHERE migration_id=?",
        manifest.migrationId,
      )[0];
      const manifestJson = JSON.stringify(manifest);
      if (existing) {
        if (existing.manifest_json !== manifestJson)
          reject("branch_initialization_conflict");
        return this.progress(manifest, existing);
      }
      const scope = sqlScope(manifest.target);
      if (
        this.sql.rows(
          "SELECT 1 FROM branch_heads WHERE root_drop_id=? AND branch_id=? UNION ALL SELECT 1 FROM branch_authorities WHERE root_drop_id=? AND branch_id=? LIMIT 1",
          ...scope,
          ...scope,
        ).length ||
        this.sql.rows(
          "SELECT 1 FROM branch_migrations WHERE root_drop_id=? AND branch_id=? AND phase NOT IN ('rolled-back')",
          ...scope,
        ).length
      )
        reject("branch_initialization_conflict");
      this.sql.execute(
        "INSERT INTO branch_migrations(migration_id,root_drop_id,branch_id,generation,phase,manifest_json,next_chunk,item_count) VALUES(?,?,?,?,'importing',?,0,0)",
        manifest.migrationId,
        ...scope,
        manifest.generation,
        manifestJson,
      );
      return this.progress(manifest, {
        phase: "importing",
        next_chunk: 0,
        item_count: 0,
      });
    });
  }

  /** Persists a typed, bounded, content-addressed import chunk; retries must be byte-identical. */
  async putChunk(
    input: BranchMigrationChunk,
    expectedGeneration: number,
  ): Promise<BranchMigrationProgress> {
    const chunk = await captureBranchMigrationChunk(input);
    return this.sql.transaction(() => {
      const { manifest, row } = this.load(chunk.migrationId);
      this.checkGeneration(manifest, row, expectedGeneration);
      if (row.phase !== "importing") reject("branch_initialization_conflict");
      if (chunk.index < Number(row.next_chunk)) {
        const prior = this.sql.rows<Row>(
          "SELECT payload_hash,payload_json,charged_bytes FROM branch_migration_chunks WHERE migration_id=? AND chunk_index=?",
          chunk.migrationId,
          chunk.index,
        )[0];
        if (
          !prior ||
          prior.payload_hash !== chunk.payloadHash ||
          prior.payload_json !== JSON.stringify(chunk.payload) ||
          Number(prior.charged_bytes) !== migrationChunkBytes(chunk.payload)
        )
          reject("diff_event_id_reused");
        return this.progress(manifest, row);
      }
      if (
        chunk.index !== Number(row.next_chunk) ||
        chunk.index >= manifest.chunkCount
      )
        reject("diff_predecessor_mismatch");
      const count = chunk.payload.length;
      if (Number(row.item_count) + count > manifest.itemCount)
        reject("invalid_command");
      const bytes = migrationChunkBytes(chunk.payload);
      const totalBytes = Number(row.payload_bytes) + bytes;
      if (totalBytes > 8_000_000) reject("capability_unsupported");
      this.sql.execute(
        "INSERT INTO branch_migration_chunks(migration_id,chunk_index,payload_hash,payload_json,charged_bytes) VALUES(?,?,?,?,?)",
        chunk.migrationId,
        chunk.index,
        chunk.payloadHash,
        JSON.stringify(chunk.payload),
        bytes,
      );
      this.sql.execute(
        "UPDATE branch_migrations SET next_chunk=?,item_count=?,payload_bytes=? WHERE migration_id=? AND generation=? AND phase='importing'",
        chunk.index + 1,
        Number(row.item_count) + count,
        totalBytes,
        chunk.migrationId,
        expectedGeneration,
      );
      return this.progress(manifest, {
        ...row,
        next_chunk: chunk.index + 1,
        item_count: Number(row.item_count) + count,
        payload_bytes: totalBytes,
      });
    });
  }

  /** Revalidates source-level contiguity, replay, identities and exact hashes before transfer. */
  async verify(
    migrationId: string,
    expectedGeneration: number,
    certificate: SourceFenceCertificate,
  ): Promise<BranchMigrationProgress> {
    const { manifest, row } = this.load(migrationId);
    this.checkGeneration(manifest, row, expectedGeneration);
    this.assertManifestCertificate(manifest, certificate);
    if (
      row.phase === "activated" ||
      (row.phase === "verified" &&
        this.sourceFence.read(certificate.target).phase === "transferred")
    )
      this.assertCertificate(manifest, certificate, "transferred");
    else {
      this.assertCertificate(manifest, certificate, "frozen");
      this.sourceFence.assertFrozen(certificate);
    }
    if (
      row.phase !== "importing" &&
      row.phase !== "verified" &&
      row.phase !== "activated"
    )
      reject("branch_initialization_pending");
    if (
      row.phase === "importing" &&
      Number(row.next_chunk) !== manifest.chunkCount
    )
      reject("branch_initialization_pending");
    const { chunks: verifiedChunks } = await this.verifyStagedPayload(
      manifest,
      row,
    );
    if (row.phase === "activated") {
      this.assertCertificate(manifest, certificate, "transferred");
      return this.progress(manifest, row);
    }
    return this.sql.transaction(() => {
      const current = this.load(migrationId);
      this.checkGeneration(current.manifest, current.row, expectedGeneration);
      if (
        current.row.phase !== "activated" &&
        !(
          current.row.phase === "verified" &&
          this.sourceFence.read(certificate.target).phase === "transferred"
        )
      )
        this.sourceFence.assertFrozen(certificate);
      else this.assertCertificate(manifest, certificate, "transferred");
      if (current.row.phase === "activated")
        return this.progress(manifest, current.row);
      if (current.row.phase === "verified") {
        this.assertChunksUnchanged(migrationId, verifiedChunks);
        return this.progress(manifest, current.row);
      }
      if (current.row.phase !== "importing")
        reject("branch_initialization_conflict");
      this.assertChunksUnchanged(migrationId, verifiedChunks);
      this.sql.execute(
        "UPDATE branch_migrations SET phase='verified' WHERE migration_id=? AND generation=? AND phase='importing'",
        migrationId,
        expectedGeneration,
      );
      return this.progress(manifest, { ...current.row, phase: "verified" });
    });
  }

  /** Commits the irreversible transfer separately so a restarted coordinator can recover forward before publication. */
  async transfer(
    migrationId: string,
    expectedGeneration: number,
    certificate: SourceFenceCertificate,
  ): Promise<BranchMigrationProgress> {
    const { manifest, row } = this.load(migrationId);
    this.checkGeneration(manifest, row, expectedGeneration);
    this.assertManifestCertificate(manifest, certificate);
    if (row.phase === "activated") {
      this.assertCertificate(manifest, certificate, "transferred");
      return this.progress(manifest, row);
    }
    if (row.phase !== "verified") reject("branch_initialization_pending");
    const { records, chunks } = await this.verifyStagedPayload(manifest, row);
    // All fallible publication preparation must succeed before source retirement.
    await this.preparePublication(manifest, records);
    const progress = this.sql.transaction(() => {
      const current = this.load(migrationId);
      this.checkGeneration(manifest, current.row, expectedGeneration);
      if (current.row.phase === "activated") {
        this.assertCertificate(manifest, certificate, "transferred");
        return this.progress(manifest, current.row);
      }
      if (current.row.phase !== "verified")
        reject("branch_initialization_conflict");
      this.assertChunksUnchanged(migrationId, chunks);
      const scope = sqlScope(manifest.target);
      if (
        this.sql.rows(
          "SELECT 1 FROM branch_heads WHERE root_drop_id=? AND branch_id=? UNION ALL SELECT 1 FROM branch_authorities WHERE root_drop_id=? AND branch_id=? LIMIT 1",
          ...scope,
          ...scope,
        ).length
      )
        reject("branch_initialization_conflict");
      const source = this.sourceFence.read(certificate.target);
      this.assertCertificate(
        manifest,
        certificate,
        source.phase === "transferred" ? "transferred" : "frozen",
      );
      return this.progress(manifest, current.row);
    });
    // No await separates the validated import from the fence's synchronous transaction.
    this.sourceFence.transfer(certificate);
    return progress;
  }

  /** Irrevocably transfers source ownership, then atomically activates all imported tables; retry is recovery-forward. */
  async activate(
    migrationId: string,
    expectedGeneration: number,
    certificate: SourceFenceCertificate,
  ): Promise<BranchMigrationProgress> {
    const { manifest, row } = this.load(migrationId);
    this.checkGeneration(manifest, row, expectedGeneration);
    this.assertManifestCertificate(manifest, certificate);
    if (row.phase === "activated") {
      this.assertCertificate(manifest, certificate, "transferred");
      return this.progress(manifest, row);
    }
    if (row.phase !== "verified") reject("branch_initialization_pending");
    const { records, chunks: persistedChunks } = await this.verifyStagedPayload(
      manifest,
      row,
    );
    const prepared = await this.preparePublication(manifest, records);
    this.sql.transaction(() => {
      const current = this.load(migrationId);
      this.checkGeneration(manifest, current.row, expectedGeneration);
      if (current.row.phase !== "verified")
        reject("branch_initialization_conflict");
      this.assertChunksUnchanged(migrationId, persistedChunks);
      const scope = sqlScope(manifest.target);
      if (
        this.sql.rows(
          "SELECT 1 FROM branch_heads WHERE root_drop_id=? AND branch_id=? UNION ALL SELECT 1 FROM branch_authorities WHERE root_drop_id=? AND branch_id=? LIMIT 1",
          ...scope,
          ...scope,
        ).length
      )
        reject("branch_initialization_conflict");
    });
    const sourceState = this.sourceFence.read(certificate.target);
    if (sourceState.phase === "frozen") this.sourceFence.transfer(certificate);
    else if (
      sourceState.phase !== "transferred" ||
      sourceState.generation !== certificate.sourceGeneration ||
      sourceState.migrationId !== migrationId ||
      sourceState.active !== 0
    )
      reject("routing_placement_mismatch");
    return this.sql.transaction(() => {
      const current = this.load(migrationId);
      this.checkGeneration(manifest, current.row, expectedGeneration);
      if (current.row.phase === "activated")
        return this.progress(manifest, current.row);
      if (current.row.phase !== "verified")
        reject("branch_initialization_conflict");
      const source = this.sourceFence.read(certificate.target);
      if (
        source.phase !== "transferred" ||
        source.generation !== certificate.sourceGeneration ||
        source.migrationId !== migrationId ||
        source.active !== 0
      )
        reject("routing_placement_mismatch");
      this.assertChunksUnchanged(migrationId, persistedChunks);
      this.publish(manifest, records, prepared);
      this.sql.execute(
        "UPDATE branch_migrations SET phase='activated' WHERE migration_id=? AND generation=? AND phase='verified'",
        migrationId,
        expectedGeneration,
      );
      return this.progress(manifest, { ...current.row, phase: "activated" });
    });
  }

  /** Deletes only pre-transfer staging and advances the source fence generation before reopening legacy writes. */
  rollback(
    migrationId: string,
    expectedGeneration: number,
    certificate: SourceFenceCertificate,
  ): BranchMigrationProgress {
    const { manifest, row } = this.load(migrationId);
    this.checkGeneration(manifest, row, expectedGeneration);
    this.assertManifestCertificate(manifest, certificate);
    if (row.phase === "rolled-back") {
      const state = this.sourceFence.read(certificate.target);
      if (
        state.phase !== "legacy" ||
        state.generation < certificate.sourceGeneration + 1 ||
        state.migrationId !== null
      )
        reject("routing_placement_mismatch");
      return {
        ...this.progress(manifest, row),
        generation: certificate.sourceGeneration + 1,
      };
    }
    if (
      row.phase !== "importing" &&
      row.phase !== "verified" &&
      row.phase !== "rollback-pending"
    )
      reject("branch_initialization_conflict");
    if (row.phase !== "rollback-pending") {
      this.assertCertificate(manifest, certificate, "frozen");
      this.sourceFence.assertFrozen(certificate);
      this.sql.transaction(() => {
        const current = this.load(migrationId);
        this.checkGeneration(manifest, current.row, expectedGeneration);
        if (
          current.row.phase !== "importing" &&
          current.row.phase !== "verified"
        )
          reject("branch_initialization_conflict");
        this.sql.execute(
          "UPDATE branch_migrations SET phase='rollback-pending' WHERE migration_id=? AND generation=?",
          migrationId,
          expectedGeneration,
        );
      });
    }
    let source = this.sourceFence.read(certificate.target);
    if (source.phase === "frozen") {
      try {
        source = this.sourceFence.abort(certificate);
      } catch (error) {
        source = this.sourceFence.read(certificate.target);
        if (source.phase !== "transferred") throw error;
        this.sql.transaction(() => {
          this.sql.execute(
            "UPDATE branch_migrations SET phase='verified' WHERE migration_id=? AND generation=? AND phase='rollback-pending'",
            migrationId,
            expectedGeneration,
          );
        });
        reject("branch_initialization_conflict");
      }
    } else if (
      source.phase !== "legacy" ||
      source.generation !== certificate.sourceGeneration + 1 ||
      source.migrationId !== null
    ) {
      if (source.phase === "transferred") {
        this.sql.transaction(() => {
          this.sql.execute(
            "UPDATE branch_migrations SET phase='verified' WHERE migration_id=? AND generation=? AND phase='rollback-pending'",
            migrationId,
            expectedGeneration,
          );
        });
        reject("branch_initialization_conflict");
      }
      reject("routing_placement_mismatch");
    }
    const result = this.sql.transaction(() => {
      const current = this.load(migrationId);
      this.checkGeneration(manifest, current.row, expectedGeneration);
      if (current.row.phase !== "rollback-pending")
        reject("branch_initialization_conflict");
      const settledSource = this.sourceFence.read(certificate.target);
      if (
        settledSource.phase !== "legacy" ||
        settledSource.generation !== certificate.sourceGeneration + 1 ||
        settledSource.migrationId !== null
      )
        reject("routing_placement_mismatch");
      this.sql.execute(
        "DELETE FROM branch_migration_chunks WHERE migration_id=?",
        migrationId,
      );
      this.sql.execute(
        "UPDATE branch_migrations SET phase='rolled-back',next_chunk=0,item_count=0,payload_bytes=0 WHERE migration_id=? AND generation=?",
        migrationId,
        expectedGeneration,
      );
      return this.progress(manifest, {
        ...current.row,
        phase: "rolled-back",
        next_chunk: 0,
        item_count: 0,
        payload_bytes: 0,
      });
    });
    return { ...result, generation: certificate.sourceGeneration + 1 };
  }

  /** Explicit shadow-only read of verified source records; normal State Plane reads remain not-found until activation. */
  readVerifiedShadow(
    migrationId: string,
    capability: "migration-shadow-read",
  ): BranchMigrationRecord[] {
    if (capability !== "migration-shadow-read") reject("forbidden");
    const { row } = this.load(migrationId);
    if (row.phase !== "verified") reject("branch_initialization_pending");
    this.assertPersistedPayloadLimits(migrationId);
    return this.readRawRecords(migrationId);
  }

  private async preparePublication(
    manifest: BranchMigrationManifest,
    records: BranchMigrationRecord[],
  ): Promise<{
    authority: BranchAuthorityRecord;
    initialized: Awaited<ReturnType<typeof prepareBranchInitialization>>;
    diffHashes: Map<string, string>;
    runtimeHashes: Map<string, string>;
    memoryHash: string;
    snapshotHashes: Map<number, string>;
  }> {
    const branches = records.filter((item) => item.kind === "branch");
    const snapshots = records.filter((item) => item.kind === "snapshot");
    const events = records.filter((item) => item.kind === "event");
    if (branches.length !== 1 || snapshots.length === 0)
      reject("state_corrupt");
    const branch = branches[0].value;
    const snapshotHashes = new Map<number, string>();
    for (const item of snapshots)
      snapshotHashes.set(
        item.value.snapshot.snapshotId,
        await hashNulldownSourceContent(item.value.content),
      );
    const first = snapshots[0].value;
    const query = {
      target: manifest.target,
      placement: {
        routingVersion: 1 as const,
        generation: manifest.generation,
      },
    };
    const reservation = {
      reservationId: manifest.migrationId,
      rootRevision: manifest.fence.sourceRevision,
      createdAt: branch.createdAt,
      identity: {
        baseDropId: branch.baseDropId,
        mode: branch.mode,
        ownerAccountId: branch.ownerAccountId,
        writerAccountId: branch.writerAccountId,
        writerClientId: branch.writerClientId,
      },
    };
    const authority: BranchAuthorityRecord = {
      ...query,
      backend: "state-plane",
      state: "pending",
      reservation,
    };
    const init: BranchInitializeRecord = {
      ...query,
      reservationId: manifest.migrationId,
      rootRevision: manifest.fence.sourceRevision,
      content: first.content,
    };
    const initialized = await prepareBranchInitialization(authority, init);
    const diffHashes = await hashBranchBatchEvents(
      events.map((item) => item.value.event),
    );
    const runtimeHashes = new Map<string, string>();
    for (const item of records.filter(
      (entry) => entry.kind === "runtime-fact",
    )) {
      const intent = runtimeFactIntent(item.value.fact);
      runtimeHashes.set(
        runtimeFactIdentity(item.value.fact),
        await hashRuntimeFactIntent(intent),
      );
    }
    const memoryHash = await hashMigrationPayload(
      records.filter((item) => item.kind === "nullmem")[0]?.value.records ?? [],
    );
    return {
      authority,
      initialized,
      diffHashes: new Map(
        diffHashes.map((item) => [item.event.eventId, item.payloadHash]),
      ),
      runtimeHashes,
      memoryHash,
      snapshotHashes,
    };
  }

  private publish(
    manifest: BranchMigrationManifest,
    records: BranchMigrationRecord[],
    preparedImport: {
      authority: BranchAuthorityRecord;
      initialized: Awaited<ReturnType<typeof prepareBranchInitialization>>;
      diffHashes: Map<string, string>;
      runtimeHashes: Map<string, string>;
      memoryHash: string;
      snapshotHashes: Map<number, string>;
    },
  ): void {
    const branches = records.filter((item) => item.kind === "branch");
    const snapshots = records.filter((item) => item.kind === "snapshot");
    const events = records.filter((item) => item.kind === "event");
    const facts = records.filter((item) => item.kind === "runtime-fact");
    const memories = records.filter((item) => item.kind === "nullmem");
    if (branches.length !== 1 || memories.length > 1) reject("state_corrupt");
    const branch = branches[0].value;
    const snapshotValues = snapshots.map((item) => item.value);
    const eventValues = events.map((item) => item.value);
    const {
      authority,
      initialized,
      diffHashes,
      runtimeHashes,
      memoryHash,
      snapshotHashes,
    } = preparedImport;
    const target = manifest.target;
    const placement = {
      routingVersion: 1 as const,
      generation: manifest.generation,
    };
    const query = { target, placement };
    const prepared = initialized;
    const firstSnapshot = snapshotValues[0];
    const initialSnapshotFields = { ...firstSnapshot.snapshot };
    delete initialSnapshotFields.checkpointKey;
    const normalizedInitialSnapshot = {
      ...initialSnapshotFields,
      sourceContentHash: snapshotHashes.get(0),
      checkpointed: true,
      patchStartSeq: null,
      patchEndSeq: null,
    };
    if (
      serializeCanonicalJson(prepared.snapshot) !==
        serializeCanonicalJson(normalizedInitialSnapshot) ||
      prepared.head.branch.createdAt !== branch.createdAt
    )
      reject("state_corrupt");
    const versions: BranchStateVersion[] = snapshotValues.map((item) => ({
      snapshotId: item.snapshot.snapshotId,
      eventSeq: item.snapshot.patchEndSeq ?? -1,
      sourceContentHash: snapshotHashes.get(
        item.snapshot.snapshotId,
      )! as BranchStateVersion["sourceContentHash"],
    }));
    const endVersion = versions.at(-1)!;
    const currentBranch = {
      ...branch,
      snapshotHeapVersion: 2,
      checkpointInterval: 24,
      headEventSeq: endVersion.eventSeq,
    };
    const head: BranchStateHead = {
      ...query,
      branch: currentBranch,
      version: endVersion,
    };
    this.sql.execute(
      "INSERT INTO branch_authorities(root_drop_id,branch_id,authority_json,initialization_intent,initialization_receipt_json) VALUES(?,?,?,?,?)",
      ...sqlScope(target),
      JSON.stringify({ ...authority, state: "active" }),
      prepared.intent,
      JSON.stringify(prepared.receipt satisfies BranchInitializationReceipt),
    );
    this.sql.execute(
      "INSERT INTO branch_migration_branch_provenance(migration_id,root_drop_id,branch_id,source_branch_json) VALUES(?,?,?,?)",
      manifest.migrationId,
      ...sqlScope(target),
      JSON.stringify(branch),
    );
    this.sql.execute(
      "INSERT INTO branch_heads(root_drop_id,branch_id,routing_version,generation,head_json) VALUES(?,?,?,?,?)",
      ...sqlScope(target),
      1,
      manifest.generation,
      JSON.stringify(head),
    );
    for (const [index, item] of snapshotValues.entries()) {
      const sourceContentHash = snapshotHashes.get(item.snapshot.snapshotId)!;
      const snapshotFields = { ...item.snapshot };
      delete snapshotFields.checkpointKey;
      const snapshot = {
        ...snapshotFields,
        sourceContentHash,
        checkpointed: true,
        ...(item.snapshot.snapshotId === 0
          ? { patchStartSeq: null, patchEndSeq: null }
          : {}),
      };
      this.sql.execute(
        "INSERT INTO branch_snapshots(root_drop_id,branch_id,snapshot_id,event_seq,source_content_hash,content,snapshot_json) VALUES(?,?,?,?,?,?,?)",
        ...sqlScope(target),
        snapshot.snapshotId,
        versions[index].eventSeq,
        sourceContentHash,
        encodeBranchSqlText(item.content),
        JSON.stringify(snapshot),
      );
      this.sql.execute(
        "INSERT INTO branch_migration_snapshot_provenance(migration_id,snapshot_id,source_snapshot_json,source_content_hash) VALUES(?,?,?,?)",
        manifest.migrationId,
        snapshot.snapshotId,
        JSON.stringify(item.snapshot),
        sourceContentHash,
      );
    }
    for (const { event } of eventValues) {
      const snapshotId = snapshotValues.findIndex(
        (item, index) =>
          index > 0 && item.snapshot.eventIds.includes(event.eventId),
      );
      const snapshot = snapshotValues[snapshotId]?.snapshot;
      if (
        snapshotId < 1 ||
        !snapshot ||
        event.seq < (snapshot.patchStartSeq ?? 0) ||
        event.seq > (snapshot.patchEndSeq ?? -1)
      )
        reject("state_corrupt");
      const acknowledgement = {
        eventId: event.eventId,
        seq: event.seq,
        snapshotId,
        status: "accepted" as const,
      };
      const snap = snapshotValues[acknowledgement.snapshotId]?.snapshot;
      const version = versions[acknowledgement.snapshotId];
      if (!snap || !version) reject("state_corrupt");
      const storedEvent = { ...event, snapshotId };
      const receipt: BranchCommitReceipt = {
        ...query,
        eventId: event.eventId,
        payloadHash: diffHashes.get(
          event.eventId,
        )! as BranchCommitReceipt["payloadHash"],
        eventSeq: acknowledgement.seq,
        version,
      };
      this.sql.execute(
        "INSERT INTO branch_events(root_drop_id,branch_id,event_seq,event_id,snapshot_id,event_json) VALUES(?,?,?,?,?,?)",
        ...sqlScope(target),
        event.seq,
        encodeBranchSqlText(event.eventId),
        acknowledgement.snapshotId,
        JSON.stringify(storedEvent),
      );
      this.sql.execute(
        "INSERT INTO branch_migration_event_provenance(migration_id,event_id,source_event_json,snapshot_id) VALUES(?,?,?,?)",
        manifest.migrationId,
        encodeBranchSqlText(event.eventId),
        JSON.stringify(event),
        snapshotId,
      );
      this.sql.execute(
        "INSERT INTO branch_receipts(root_drop_id,branch_id,event_id,payload_hash,receipt_json) VALUES(?,?,?,?,?)",
        ...sqlScope(target),
        encodeBranchSqlText(event.eventId),
        receipt.payloadHash,
        JSON.stringify(receipt),
      );
      this.sql.execute(
        "INSERT INTO branch_migration_public_acks(migration_id,event_id,acknowledgement_json,provenance) VALUES(?,?,?,'derived-from-legacy-snapshot-event-range')",
        manifest.migrationId,
        encodeBranchSqlText(event.eventId),
        JSON.stringify(acknowledgement),
      );
    }
    for (const item of facts) {
      const sourceEvent = item.value;
      const snapshotId = this.runtimeSourceSnapshotId(
        sourceEvent,
        snapshotHashes,
      );
      const event = {
        ...sourceEvent,
        fact: {
          ...sourceEvent.fact,
          createdAt: sourceEvent.createdAt,
          source: { ...sourceEvent.fact.source, snapshotId },
        },
      };
      this.publishRuntimeFact(
        manifest,
        event,
        head,
        runtimeHashes.get(runtimeFactIdentity(event.fact))!,
        sourceEvent,
      );
    }
    if (memories.length)
      this.publishNullMem(
        manifest,
        memories[0].value.records,
        head,
        memoryHash,
      );
    // Source history is imported, not replayed. The initialization receipt belongs to this destination migration.
    if (
      serializeCanonicalJson(head.branch) !==
      serializeCanonicalJson({
        ...branch,
        snapshotHeapVersion: 2,
        checkpointInterval: 24,
        headEventSeq: endVersion.eventSeq,
      })
    )
      reject("state_corrupt");
  }

  private publishRuntimeFact(
    manifest: BranchMigrationManifest,
    event: Extract<BranchMigrationRecord, { kind: "runtime-fact" }>["value"],
    head: BranchStateHead,
    payloadHash: string,
    sourceEvent: Extract<
      BranchMigrationRecord,
      { kind: "runtime-fact" }
    >["value"],
  ): void {
    const query = {
      target: manifest.target,
      placement: { routingVersion: 1, generation: manifest.generation },
    };
    validateRuntimeFactEvent(event, query, { allowMissingActor: true });
    const fact = event.fact;
    const identity = runtimeFactIdentity(fact);
    const intent = runtimeFactIntent(fact);
    const receipt: BranchRuntimeFactReceipt = {
      identity,
      payloadHash: payloadHash as BranchRuntimeFactReceipt["payloadHash"],
      key: runtimeFactKey(fact),
      event,
    };
    const outbox = runtimeFactOutbox(query, receipt);
    this.sql.execute(
      "INSERT INTO branch_runtime_facts(root_drop_id,branch_id,identity,fact_id,fact_key,seq,event_json) VALUES(?,?,?,?,?,?,?)",
      ...sqlScope(query.target),
      identity,
      encodeBranchSqlText(event.factId),
      encodeBranchSqlText(receipt.key),
      event.seq,
      JSON.stringify(event),
    );
    this.sql.execute(
      "INSERT INTO branch_runtime_fact_receipts(root_drop_id,branch_id,identity,intent,receipt_json) VALUES(?,?,?,?,?)",
      ...sqlScope(query.target),
      identity,
      intent,
      JSON.stringify(receipt),
    );
    this.sql.execute(
      "INSERT INTO branch_runtime_fact_outbox(root_drop_id,branch_id,identity,outbox_id,outbox_json) VALUES(?,?,?,?,?)",
      ...sqlScope(query.target),
      identity,
      outbox.id,
      JSON.stringify(outbox),
    );
    this.sql.execute(
      "INSERT INTO branch_runtime_fact_imports(root_drop_id,branch_id,identity,migration_id,source_seq,source_event_json) VALUES(?,?,?,?,?,?)",
      ...sqlScope(query.target),
      identity,
      manifest.migrationId,
      event.seq,
      JSON.stringify(sourceEvent),
    );
    this.sql.execute(
      "INSERT INTO branch_imported_outbox(outbox_id,migration_id,source_kind) VALUES(?,?,'runtime')",
      outbox.id,
      manifest.migrationId,
    );
    const existing = this.sql.rows(
      "SELECT head_seq FROM branch_runtime_fact_heads WHERE root_drop_id=? AND branch_id=?",
      ...sqlScope(query.target),
    )[0];
    if (!existing || event.seq > Number(existing.head_seq))
      this.sql.execute(
        "INSERT INTO branch_runtime_fact_heads(root_drop_id,branch_id,head_seq) VALUES(?,?,?) ON CONFLICT(root_drop_id,branch_id) DO UPDATE SET head_seq=excluded.head_seq",
        ...sqlScope(query.target),
        event.seq,
      );
    if (event.fact.source.snapshotId! > head.version.snapshotId)
      reject("state_corrupt");
  }

  private publishNullMem(
    manifest: BranchMigrationManifest,
    records: BranchNullMemRecord[],
    head: BranchStateHead,
    sourceHash: string,
  ): void {
    for (const record of records) {
      validateNullMemRecord(record, head);
      this.sql.execute(
        "INSERT INTO branch_nullmem_records(root_drop_id,branch_id,identity,record_json) VALUES(?,?,?,?)",
        ...sqlScope(manifest.target),
        nullMemRecordIdentity(record),
        JSON.stringify(record),
      );
    }
    this.sql.execute(
      "INSERT INTO branch_nullmem_import_baseline(root_drop_id,branch_id,migration_id,memory_revision,source_hash,records_json) VALUES(?,?,?,0,?,?)",
      ...sqlScope(manifest.target),
      manifest.migrationId,
      sourceHash,
      JSON.stringify(records),
    );
  }

  private async validateRecords(
    manifest: BranchMigrationManifest,
    records: BranchMigrationRecord[],
  ): Promise<void> {
    const branchRows = records.filter((record) => record.kind === "branch");
    const snapshots = records
      .filter((record) => record.kind === "snapshot")
      .map((record) => record.value);
    const events = records
      .filter((record) => record.kind === "event")
      .map((record) => record.value);
    const facts = records
      .filter((record) => record.kind === "runtime-fact")
      .map((record) => record.value);
    const memories = records.filter((record) => record.kind === "nullmem");
    if (branchRows.length !== 1 || memories.length > 1) reject("state_corrupt");
    const branch = branchRows[0].value;
    if (
      !isDropBranchRecord(branch) ||
      branch.rootDropId !== manifest.target.rootDropId ||
      branch.branchId !== manifest.target.branchId ||
      branch.status !== "active"
    )
      reject("state_corrupt");
    if (snapshots.length > 256) reject("capability_unsupported");
    if (
      snapshots.length !== branch.headSnapshotId + 1 ||
      snapshots.length === 0 ||
      snapshots[0].snapshot.snapshotId !== 0
    )
      reject("state_corrupt");
    for (const [id, item] of snapshots.entries()) {
      const snap = item.snapshot;
      const contentHash = await hashNulldownSourceContent(item.content);
      if (
        !isDropSnapshotRecord(snap) ||
        snap.rootDropId !== branch.rootDropId ||
        snap.branchId !== branch.branchId ||
        snap.snapshotId !== id ||
        snap.seq !== id ||
        (item.contentHash !== undefined && item.contentHash !== contentHash) ||
        (snap.sourceContentHash !== undefined &&
          snap.sourceContentHash !== contentHash) ||
        snap.textLength !== item.content.length
      )
        reject("state_corrupt");
      if (
        id === 0
          ? snap.parentSnapshotId !== null ||
            snap.eventIds.length !== 0 ||
            snap.patchStartSeq != null ||
            snap.patchEndSeq != null
          : snap.parentSnapshotId !== id - 1
      )
        reject("state_corrupt");
    }
    if (events.length > 10_000 || facts.length > 10_000)
      reject("capability_unsupported");
    if (events.length !== (branch.headEventSeq ?? -1) + 1)
      reject("state_corrupt");
    const ordered = [...events].sort((a, b) => a.event.seq - b.event.seq);
    if (
      ordered.some(
        (item, seq) =>
          !isDropDiffEvent(item.event) ||
          item.event.seq !== seq ||
          item.event.dropId !== manifest.target.rootDropId ||
          (item.event.metadata?.followsSeq !== undefined &&
            item.event.metadata.followsSeq !== seq - 1) ||
          item.acknowledgement.eventId !== item.event.eventId ||
          item.acknowledgement.seq !== seq ||
          item.acknowledgement.status !== "accepted",
      )
    )
      reject("state_corrupt");
    const bySnapshot = new Map<number, typeof ordered>();
    const assigned = new Set<string>();
    for (let sid = 1; sid < snapshots.length; sid++) {
      const snap = snapshots[sid].snapshot;
      if (
        !Number.isSafeInteger(snap.patchStartSeq) ||
        !Number.isSafeInteger(snap.patchEndSeq) ||
        snap.patchStartSeq! < 0 ||
        snap.patchEndSeq! < snap.patchStartSeq!
      )
        reject("state_corrupt");
      const inSnapshot = ordered.filter(
        (item) =>
          item.event.seq >= snap.patchStartSeq! &&
          item.event.seq <= snap.patchEndSeq!,
      );
      if (
        inSnapshot.length !== snap.patchEndSeq! - snap.patchStartSeq! + 1 ||
        inSnapshot.some(
          (item, index) => item.event.seq !== snap.patchStartSeq! + index,
        ) ||
        serializeCanonicalJson(snap.eventIds) !==
          serializeCanonicalJson(inSnapshot.map((item) => item.event.eventId))
      )
        reject("state_corrupt");
      for (const item of inSnapshot) {
        if (
          assigned.has(item.event.eventId) ||
          item.acknowledgement.snapshotId !== sid ||
          (item.event.snapshotId !== undefined && item.event.snapshotId !== sid)
        )
          reject("state_corrupt");
        assigned.add(item.event.eventId);
      }
      bySnapshot.set(sid, inSnapshot);
      let replay = snapshots[sid - 1].content;
      for (const { event } of inSnapshot)
        for (const rawOp of event.ops) {
          const op = DropDiffOperation.fromRecord(rawOp).toDiff();
          if (op.op === DiffOp.INSERT || op.op === DiffOp.DELETE)
            replay = applyDiff(replay, op);
        }
      if (replay !== snapshots[sid].content) reject("state_corrupt");
    }
    if (assigned.size !== ordered.length) reject("state_corrupt");
    const snapshotHashes = await Promise.all(
      snapshots.map((item) => hashNulldownSourceContent(item.content)),
    );
    if (
      facts.some(
        (event, seq) =>
          !isDropBranchRuntimeFact(event) ||
          event.seq !== seq ||
          event.rootDropId !== branch.rootDropId ||
          event.branchId !== branch.branchId ||
          !snapshotHashes.includes(
            event.fact.source
              .sourceContentHash! as (typeof snapshotHashes)[number],
          ) ||
          (event.fact.source.snapshotId !== undefined &&
            (event.fact.source.snapshotId >= snapshots.length ||
              event.fact.source.sourceContentHash !==
                snapshotHashes[event.fact.source.snapshotId])),
      )
    )
      reject("state_corrupt");
    for (const event of facts)
      this.runtimeSourceSnapshotId(
        event,
        new Map(snapshotHashes.map((hash, id) => [id, hash])),
      );
    if (memories.length && memories[0].value.records.length > 5_000)
      reject("capability_unsupported");
    if (
      memories.length &&
      (memories[0].value.revision !== 0 ||
        memories[0].value.outbox.length !== 0)
    )
      reject("state_corrupt");
    const seen = new Set<string>();
    for (const item of memories)
      for (const record of item.value.records) {
        validateNullMemRecord(record, {
          target: manifest.target,
          placement: { routingVersion: 1, generation: manifest.generation },
        });
        const key = nullMemRecordIdentity(record);
        if (seen.has(key)) reject("state_corrupt");
        seen.add(key);
      }
  }

  private runtimeSourceSnapshotId(
    event: Extract<BranchMigrationRecord, { kind: "runtime-fact" }>["value"],
    hashes: Map<number, string>,
  ): number {
    const sourceHash = event.fact.source.sourceContentHash;
    const matches = [...hashes.entries()]
      .filter(([, hash]) => hash === sourceHash)
      .map(([id]) => id);
    if (event.fact.source.snapshotId !== undefined) {
      if (hashes.get(event.fact.source.snapshotId) !== sourceHash)
        reject("state_corrupt");
      return event.fact.source.snapshotId;
    }
    if (matches.length !== 1) reject("capability_unsupported");
    return matches[0];
  }

  private assertCertificate(
    manifest: BranchMigrationManifest,
    certificate: SourceFenceCertificate,
    phase: "frozen" | "transferred",
  ): void {
    this.assertManifestCertificate(manifest, certificate);
    const state = this.sourceFence.read(certificate.target);
    if (
      state.phase !== phase ||
      state.generation !== certificate.sourceGeneration ||
      state.migrationId !== manifest.migrationId ||
      state.active !== 0
    )
      reject("routing_placement_mismatch");
  }
  private assertManifestCertificate(
    manifest: BranchMigrationManifest,
    certificate: SourceFenceCertificate,
  ): void {
    if (
      certificate.migrationId !== manifest.migrationId ||
      certificate.sourceGeneration !== manifest.fence.sourceGeneration ||
      manifest.generation !== certificate.sourceGeneration + 1 ||
      certificate.target.rootDropId !== manifest.target.rootDropId ||
      certificate.target.branchId !== manifest.target.branchId ||
      !this.verifySourceCommitment(manifest, certificate)
    )
      reject("routing_placement_mismatch");
  }
  private async verifyStagedPayload(
    manifest: BranchMigrationManifest,
    row: Row,
  ): Promise<{
    records: BranchMigrationRecord[];
    chunks: ReturnType<SqliteBranchMigrationStaging["readRawChunks"]>;
  }> {
    this.assertPersistedPayloadLimits(manifest.migrationId);
    const chunks = this.readRawChunks(manifest.migrationId);
    if (
      chunks.length !== manifest.chunkCount ||
      Number(row.item_count) !== manifest.itemCount ||
      Number(row.next_chunk) !== manifest.chunkCount
    )
      reject("state_corrupt");
    for (let index = 0; index < chunks.length; index++)
      if (
        chunks[index].index !== index ||
        (await hashMigrationPayload(chunks[index].payload)) !==
          chunks[index].payloadHash
      )
        reject("state_corrupt");
    if (
      (await hashMigrationPayload(chunks.map((chunk) => chunk.payloadHash))) !==
      manifest.payloadHash
    )
      reject("state_corrupt");
    const records = chunks.flatMap((chunk) => chunk.payload);
    await this.validateRecords(manifest, records);
    return { records, chunks };
  }
  private assertPersistedPayloadLimits(id: string): void {
    const row = this.sql.rows<Row>(
      "SELECT COUNT(*) AS chunk_count,SUM(charged_bytes) AS charged_bytes,SUM(length(CAST(payload_json AS BLOB))) AS actual_bytes,(SELECT payload_bytes FROM branch_migrations WHERE migration_id=?) AS manifest_bytes FROM branch_migration_chunks WHERE migration_id=?",
      id,
      id,
    )[0];
    if (
      !row ||
      !Number.isSafeInteger(row.chunk_count) ||
      Number(row.chunk_count) > 8 ||
      !Number.isSafeInteger(row.charged_bytes) ||
      !Number.isSafeInteger(row.actual_bytes) ||
      Number(row.charged_bytes) !== Number(row.actual_bytes) ||
      Number(row.charged_bytes) !== Number(row.manifest_bytes) ||
      Number(row.charged_bytes) > 8_000_000
    )
      reject("capability_unsupported");
  }
  private assertChunksUnchanged(
    id: string,
    verified: ReturnType<SqliteBranchMigrationStaging["readRawChunks"]>,
  ): void {
    const current = this.sql.rows<Row>(
      "SELECT chunk_index,payload_hash,payload_json,charged_bytes FROM branch_migration_chunks WHERE migration_id=? ORDER BY chunk_index",
      id,
    );
    if (
      current.length !== verified.length ||
      current.some(
        (row, index) =>
          row.chunk_index !== verified[index].index ||
          row.payload_hash !== verified[index].payloadHash ||
          row.payload_json !== verified[index].payloadJson ||
          row.charged_bytes !== verified[index].chargedBytes,
      )
    )
      reject("state_corrupt");
  }
  private checkGeneration(
    manifest: BranchMigrationManifest,
    row: Row,
    expected: number,
  ): void {
    if (
      !Number.isSafeInteger(expected) ||
      expected !== manifest.generation ||
      row.generation !== expected
    )
      reject("routing_generation_mismatch");
  }
  private load(id: string): { manifest: BranchMigrationManifest; row: Row } {
    const row = this.sql.rows<Row>(
      "SELECT manifest_json,phase,next_chunk,item_count,payload_bytes,generation FROM branch_migrations WHERE migration_id=?",
      id,
    )[0];
    if (!row) reject("branch_not_found");
    return {
      manifest: captureBranchMigrationManifest(
        JSON.parse(String(row.manifest_json)),
      ),
      row,
    };
  }
  private readRawChunks(id: string): {
    index: number;
    payload: BranchMigrationRecord[];
    payloadHash: string;
    payloadJson: string;
    chargedBytes: number;
  }[] {
    return this.sql
      .rows<Row>(
        "SELECT chunk_index,payload_json,payload_hash,charged_bytes FROM branch_migration_chunks WHERE migration_id=? ORDER BY chunk_index",
        id,
      )
      .map((row) => ({
        index: Number(row.chunk_index),
        payload: JSON.parse(
          String(row.payload_json),
        ) as BranchMigrationRecord[],
        payloadHash: String(row.payload_hash),
        payloadJson: String(row.payload_json),
        chargedBytes: Number(row.charged_bytes),
      }));
  }
  private readRawRecords(id: string): BranchMigrationRecord[] {
    return this.readRawChunks(id).flatMap((chunk) => chunk.payload);
  }
  private progress(
    manifest: BranchMigrationManifest,
    row: Row,
  ): BranchMigrationProgress {
    return {
      migrationId: manifest.migrationId,
      phase: row.phase as BranchMigrationProgress["phase"],
      generation: manifest.generation,
      nextChunk: Number(row.next_chunk),
      chunkCount: manifest.chunkCount,
      itemCount: Number(row.item_count),
      payloadHash: manifest.payloadHash,
    };
  }
}

import { BranchLifecycleQuery } from "../../../shared/drop/branch-lifecycle";
import {
  BranchStateError,
  BranchStateQuery,
  type BranchStatePlacement,
  type BranchStateTarget,
} from "../../../shared/drop/branch-state";
import {
  captureBranchMigrationManifest,
  type BranchMigrationChunk,
  type BranchMigrationManifest,
  type BranchMigrationProgress,
} from "../../../shared/drop/branch-migration";
import type { CapturedLegacyBranch } from "./legacy-migration-source";
import { buildLegacyMigrationPayload } from "./legacy-migration-payload";
import { SqliteBranchMigrationStaging } from "./sqlite-migration";
import {
  SqliteSourceWriteFence,
  type SourceFenceCertificate,
  type SourceFenceState,
  type SourceWritePermit,
} from "./source-fence";
import { synchronousSqlResult, type BranchSqlPort } from "./sqlite-port";

/** A point-in-time routing decision, never a source write permit. */
export interface BranchAuthoritySelection {
  target: BranchStateTarget;
  backend: "legacy" | "state-plane" | "transition";
  placement: BranchStatePlacement;
  sourcePhase: SourceFenceState["phase"];
  migrationId: string | null;
}

/** Request-lifetime access to the owning shard's authority and source admission ledger. */
export interface BranchAuthorityClient {
  select(target: BranchStateTarget): Promise<BranchAuthoritySelection>;
  admit(permit: SourceWritePermit): Promise<SourceWritePermit>;
  complete(permit: SourceWritePermit): Promise<void>;
}

/** Validates a migration identity before asynchronous work or durable state access. */
export function captureMigrationCertificate(
  input: SourceFenceCertificate,
): SourceFenceCertificate {
  const query = BranchStateQuery.head({
    target: input?.target,
    placement: { routingVersion: 1, generation: input?.sourceGeneration },
  });
  if (
    typeof input.migrationId !== "string" ||
    !input.migrationId.length ||
    input.migrationId.length > 256 ||
    !/^[A-Za-z0-9._:-]+$/.test(input.migrationId) ||
    !Number.isSafeInteger(input.sourceGeneration + 1)
  )
    throw new BranchStateError("invalid_command");
  return {
    target: query.target,
    sourceGeneration: query.placement.generation,
    migrationId: input.migrationId,
  };
}

/** Validates an untrusted RPC selection against its requested branch; ambiguity never selects legacy. */
export function captureAuthoritySelection(
  value: BranchAuthoritySelection,
  target: BranchStateTarget,
): BranchAuthoritySelection {
  try {
    const query = BranchStateQuery.head({
      target: value?.target,
      placement: value?.placement,
    });
    if (
      query.target.rootDropId !== target.rootDropId ||
      query.target.branchId !== target.branchId ||
      query.placement.routingVersion !== 1 ||
      !["legacy", "draining", "frozen", "transferred"].includes(
        value.sourcePhase,
      ) ||
      (value.migrationId !== null &&
        (typeof value.migrationId !== "string" ||
          !value.migrationId.length ||
          value.migrationId.length > 256)) ||
      (value.sourcePhase === "legacy") !== (value.migrationId === null) ||
      (value.backend === "legacy"
        ? value.sourcePhase === "transferred"
        : !["transition", "state-plane"].includes(value.backend) ||
          value.sourcePhase !== "transferred") ||
      (value.backend === "state-plane" && query.placement.generation < 1)
    )
      throw Error();
    return {
      ...query,
      backend: value.backend,
      sourcePhase: value.sourcePhase,
      migrationId: value.migrationId,
    };
  } catch {
    throw new BranchStateError("state_corrupt");
  }
}

const scope = (target: BranchStateTarget) => [
  JSON.stringify(target.rootDropId),
  JSON.stringify(target.branchId),
];

/**
 * Connection-lifetime coordinator for an explicitly enrolled branch. Source gates,
 * trusted capture commitments, import progress and destination publication share
 * the owning shard's SQLite port. No request can supply an import manifest.
 */
export class SqliteBranchAuthorityControl {
  private readonly sql: BranchSqlPort;
  private readonly fence: SqliteSourceWriteFence;
  private readonly staging: SqliteBranchMigrationStaging;

  constructor(connection: BranchSqlPort) {
    // Fence and importer operations join the coordinator's outer transaction.
    // Nested exceptions propagate; the outer owner rolls back the entire operation.
    let depth = 0;
    const sql: BranchSqlPort = {
      rows: (statement, ...bindings) => connection.rows(statement, ...bindings),
      execute: (statement, ...bindings) =>
        connection.execute(statement, ...bindings),
      transaction<T>(work: () => T): T {
        if (depth > 0) return synchronousSqlResult(work());
        return connection.transaction(() => {
          depth++;
          try {
            return synchronousSqlResult(work());
          } finally {
            depth--;
          }
        });
      },
    };
    this.sql = sql;
    this.fence = new SqliteSourceWriteFence(sql);
    sql.transaction(() => {
      sql.execute(
        "CREATE TABLE IF NOT EXISTS branch_migration_sources(migration_id TEXT PRIMARY KEY, manifest_json TEXT NOT NULL)",
      );
      sql.execute(
        "CREATE TABLE IF NOT EXISTS branch_migration_source_chunks(migration_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, chunk_json TEXT NOT NULL, PRIMARY KEY(migration_id,chunk_index))",
      );
      sql.execute(
        "CREATE TABLE IF NOT EXISTS branch_migration_aborts(migration_id TEXT PRIMARY KEY, certificate_json TEXT NOT NULL, receipt_json TEXT NOT NULL)",
      );
    });
    this.staging = new SqliteBranchMigrationStaging(
      sql,
      this.fence,
      (manifest) => {
        const row = sql.rows<{ manifest_json: string }>(
          "SELECT manifest_json FROM branch_migration_sources WHERE migration_id=?",
          manifest.migrationId,
        )[0];
        return row?.manifest_json === JSON.stringify(manifest);
      },
    );
  }

  /** Explicit enrollment before the first legacy write; cannot adopt an existing destination. */
  register(target: BranchStateTarget): SourceFenceState {
    target = BranchStateQuery.head({
      target,
      placement: { routingVersion: 1, generation: 0 },
    }).target;
    return this.sql.transaction(() => {
      // Re-registration preserves a transferred fence rather than reopening it.
      const existing = this.sql.rows(
        "SELECT 1 FROM migration_source_gate WHERE root=? AND branch=?",
        ...scope(target),
      );
      if (existing.length) return this.fence.read(target);
      if (
        this.sql.rows(
          "SELECT 1 FROM branch_authorities WHERE root_drop_id=? AND branch_id=? UNION ALL SELECT 1 FROM branch_heads WHERE root_drop_id=? AND branch_id=? LIMIT 1",
          ...scope(target),
          ...scope(target),
        ).length
      )
        throw new BranchStateError("branch_initialization_conflict");
      return this.fence.register(target);
    });
  }

  /** Rejects fresh destination bootstrap for any source-enrolled target, including during drain/import. */
  assertBootstrapAllowed(target: BranchStateTarget): void {
    if (
      this.sql.rows(
        "SELECT 1 FROM migration_source_gate WHERE root=? AND branch=?",
        ...scope(target),
      ).length
    )
      throw new BranchStateError("routing_placement_mismatch");
  }

  /** Reads authority from existing durable states in one synchronous transaction. */
  select(target: BranchStateTarget): BranchAuthoritySelection {
    return this.sql.transaction(() => {
      const source = this.fence.read(target);
      const row = this.sql.rows<{ authority_json: string }>(
        "SELECT authority_json FROM branch_authorities WHERE root_drop_id=? AND branch_id=?",
        ...scope(source.target),
      )[0];
      const hasHead =
        this.sql.rows(
          "SELECT 1 FROM branch_heads WHERE root_drop_id=? AND branch_id=?",
          ...scope(source.target),
        ).length > 0;
      const base = {
        target: source.target,
        sourcePhase: source.phase,
        migrationId: source.migrationId,
      };
      const sourcePlacement = {
        routingVersion: 1,
        generation: source.generation,
      };
      if (source.phase !== "transferred") {
        if (row || hasHead) throw new BranchStateError("state_corrupt");
        return { ...base, backend: "legacy", placement: sourcePlacement };
      }
      if (source.active !== 0 || !source.migrationId)
        throw new BranchStateError("state_corrupt");
      this.manifest({
        target: source.target,
        sourceGeneration: source.generation,
        migrationId: source.migrationId,
      });
      const progress = this.staging.getProgress(source.migrationId);
      if (progress.generation !== source.generation + 1)
        throw new BranchStateError("state_corrupt");
      if (progress.phase === "verified" && !row && !hasHead)
        return { ...base, backend: "transition", placement: sourcePlacement };
      if (progress.phase !== "activated" || !row || !hasHead)
        throw new BranchStateError("state_corrupt");
      let authority;
      try {
        authority = BranchLifecycleQuery.authority(
          JSON.parse(row.authority_json),
        );
      } catch {
        throw new BranchStateError("state_corrupt");
      }
      if (
        authority.state !== "active" ||
        authority.target.rootDropId !== source.target.rootDropId ||
        authority.target.branchId !== source.target.branchId ||
        authority.placement.routingVersion !== 1 ||
        authority.placement.generation !== source.generation + 1
      )
        throw new BranchStateError("state_corrupt");
      return {
        ...base,
        backend: "state-plane",
        placement: authority.placement,
      };
    });
  }

  /** Acquires one durable permit, checking destination exclusion in the same transaction. */
  admit(permit: SourceWritePermit): SourceWritePermit {
    return this.sql.transaction(() => {
      if (this.select(permit.target).backend !== "legacy")
        throw new BranchStateError("routing_placement_mismatch");
      return this.fence.admit(permit);
    });
  }

  /** Idempotently releases only a caller-proved settled operation. */
  complete(permit: SourceWritePermit): void {
    this.fence.complete(permit);
  }

  /** Closes admission and reports drain progress without expiring uncertain writers. */
  freeze(input: SourceFenceCertificate): SourceFenceState {
    const certificate = captureMigrationCertificate(input);
    return this.sql.transaction(() => {
      // A migration identity cannot be recycled after abort or shared by two
      // branches in this shard, even before either source has been captured.
      if (
        this.sql.rows(
          "SELECT 1 FROM branch_migration_aborts WHERE migration_id=?",
          certificate.migrationId,
        ).length
      )
        throw new BranchStateError("branch_initialization_conflict");
      if (
        this.sql.rows(
          "SELECT 1 FROM migration_source_gate WHERE migration_id=? AND (root<>? OR branch<>?)",
          certificate.migrationId,
          ...scope(certificate.target),
        ).length
      )
        throw new BranchStateError("branch_initialization_conflict");
      if (
        this.sql.rows(
          "SELECT 1 FROM branch_migration_sources WHERE migration_id=?",
          certificate.migrationId,
        ).length
      )
        this.manifest(certificate);
      return this.fence.fence(certificate);
    });
  }

  /** Reads exact durable source counts for recovery; it does not grant admission. */
  source(target: BranchStateTarget): SourceFenceState {
    return this.fence.read(target);
  }

  private manifest(
    certificate: SourceFenceCertificate,
  ): BranchMigrationManifest {
    const row = this.sql.rows<{ manifest_json: string }>(
      "SELECT manifest_json FROM branch_migration_sources WHERE migration_id=?",
      certificate.migrationId,
    )[0];
    if (!row) throw new BranchStateError("branch_not_found");
    let manifest;
    try {
      manifest = captureBranchMigrationManifest(JSON.parse(row.manifest_json));
    } catch {
      throw new BranchStateError("state_corrupt");
    }
    if (
      manifest.target.rootDropId !== certificate.target.rootDropId ||
      manifest.target.branchId !== certificate.target.branchId ||
      manifest.fence.sourceGeneration !== certificate.sourceGeneration ||
      manifest.migrationId !== certificate.migrationId ||
      manifest.generation !== certificate.sourceGeneration + 1
    )
      throw new BranchStateError("routing_placement_mismatch");
    return manifest;
  }

  /** Captures configured legacy stores once, then atomically persists the source commitment and immutable chunks. */
  async prepare(
    input: SourceFenceCertificate,
    capture: (
      assertFrozen: () => Promise<void>,
    ) => Promise<CapturedLegacyBranch>,
  ): Promise<BranchMigrationProgress> {
    const certificate = captureMigrationCertificate(input);
    const existing = this.sql.rows(
      "SELECT 1 FROM branch_migration_sources WHERE migration_id=?",
      certificate.migrationId,
    );
    if (existing.length) {
      this.manifest(certificate);
      return this.staging.getProgress(certificate.migrationId);
    }
    this.fence.assertFrozen(certificate);
    const captured = await capture(async () => {
      this.fence.assertFrozen(certificate);
    });
    if (
      captured.branch.rootDropId !== certificate.target.rootDropId ||
      captured.branch.branchId !== certificate.target.branchId
    )
      throw new BranchStateError("routing_placement_mismatch");
    const payload = await buildLegacyMigrationPayload(captured, {
      migrationId: certificate.migrationId,
      sourceId: `legacy:${certificate.target.rootDropId}`,
      sourceGeneration: certificate.sourceGeneration,
      certification: `capture:${captured.captureHash}`,
    });
    return this.sql.transaction(() => {
      this.fence.assertFrozen(certificate);
      const manifestJson = JSON.stringify(payload.manifest);
      const prior = this.sql.rows<{ manifest_json: string }>(
        "SELECT manifest_json FROM branch_migration_sources WHERE migration_id=?",
        certificate.migrationId,
      )[0];
      if (prior && prior.manifest_json !== manifestJson)
        throw new BranchStateError("branch_initialization_conflict");
      if (!prior) {
        this.sql.execute(
          "INSERT INTO branch_migration_sources(migration_id,manifest_json) VALUES(?,?)",
          certificate.migrationId,
          manifestJson,
        );
        for (const chunk of payload.chunks)
          this.sql.execute(
            "INSERT INTO branch_migration_source_chunks(migration_id,chunk_index,chunk_json) VALUES(?,?,?)",
            certificate.migrationId,
            chunk.index,
            JSON.stringify(chunk),
          );
      }
      return this.staging.admit(payload.manifest, certificate);
    });
  }

  /** Imports one persisted source chunk by index; network retries cannot substitute a different payload. */
  async importChunk(
    input: SourceFenceCertificate,
    index: number,
  ): Promise<BranchMigrationProgress> {
    const certificate = captureMigrationCertificate(input);
    this.manifest(certificate);
    if (!Number.isSafeInteger(index) || index < 0)
      throw new BranchStateError("invalid_command");
    const row = this.sql.rows<{ chunk_json: string }>(
      "SELECT chunk_json FROM branch_migration_source_chunks WHERE migration_id=? AND chunk_index=?",
      certificate.migrationId,
      index,
    )[0];
    if (!row) throw new BranchStateError("invalid_command");
    const progress = this.staging.getProgress(certificate.migrationId);
    if (
      ["verified", "activated"].includes(progress.phase) &&
      index < progress.nextChunk
    )
      return progress;
    this.fence.assertFrozen(certificate);
    return this.staging.putChunk(
      JSON.parse(row.chunk_json) as BranchMigrationChunk,
      certificate.sourceGeneration + 1,
    );
  }

  /** Returns persisted progress using the exact target and source generation. */
  progress(input: SourceFenceCertificate): BranchMigrationProgress {
    const certificate = captureMigrationCertificate(input);
    this.manifest(certificate);
    return this.staging.getProgress(certificate.migrationId);
  }

  /** Compares every staged record with the persisted source commitment before transfer. */
  verify(input: SourceFenceCertificate): Promise<BranchMigrationProgress> {
    const certificate = captureMigrationCertificate(input);
    this.manifest(certificate);
    return this.staging.verify(
      certificate.migrationId,
      certificate.sourceGeneration + 1,
      certificate,
    );
  }

  /** Retires the source only after full verification and publication preparation; retry is exact. */
  transfer(input: SourceFenceCertificate): Promise<BranchMigrationProgress> {
    const certificate = captureMigrationCertificate(input);
    this.manifest(certificate);
    return this.staging.transfer(
      certificate.migrationId,
      certificate.sourceGeneration + 1,
      certificate,
    );
  }

  /** Recovers forward from persisted transfer; publication is atomic and never reopens the source. */
  activate(input: SourceFenceCertificate): Promise<BranchMigrationProgress> {
    const certificate = captureMigrationCertificate(input);
    this.manifest(certificate);
    return this.staging.activate(
      certificate.migrationId,
      certificate.sourceGeneration + 1,
      certificate,
    );
  }

  /** Aborts before transfer, including capture failures; exact retries return the durable receipt without reopening again. */
  abort(
    input: SourceFenceCertificate,
  ): BranchMigrationProgress | SourceFenceState {
    const certificate = captureMigrationCertificate(input);
    return this.sql.transaction(() => {
      const certificateJson = JSON.stringify(certificate);
      const prior = this.sql.rows<{
        certificate_json: string;
        receipt_json: string;
      }>(
        "SELECT certificate_json,receipt_json FROM branch_migration_aborts WHERE migration_id=?",
        certificate.migrationId,
      )[0];
      if (prior) {
        if (prior.certificate_json !== certificateJson)
          throw new BranchStateError("routing_placement_mismatch");
        return JSON.parse(prior.receipt_json) as
          BranchMigrationProgress | SourceFenceState;
      }
      const prepared =
        this.sql.rows(
          "SELECT 1 FROM branch_migration_sources WHERE migration_id=?",
          certificate.migrationId,
        ).length > 0;
      if (prepared) this.manifest(certificate);
      const receipt = prepared
        ? this.staging.rollback(
            certificate.migrationId,
            certificate.sourceGeneration + 1,
            certificate,
          )
        : this.fence.abort(certificate);
      this.sql.execute(
        "INSERT INTO branch_migration_aborts(migration_id,certificate_json,receipt_json) VALUES(?,?,?)",
        certificate.migrationId,
        certificateJson,
        JSON.stringify(receipt),
      );
      return receipt;
    });
  }
}

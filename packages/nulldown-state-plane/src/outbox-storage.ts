import type { ArchivePort, ProjectionPort } from "./outbox-platform";
import { serializeCanonicalJson } from "../../../shared/drop/types";

/** R2 adapter using create-only writes and metadata inspection for semantic idempotency. */
export class R2OutboxArchive implements ArchivePort {
  /** Binds a request-scoped archive adapter to the configured R2 bucket. */
  constructor(private readonly bucket: R2Bucket) {}

  /** Atomically creates an archive object only when no object exists at the key. */
  async putIfAbsent(
    key: string,
    body: string,
    customMetadata: Record<string, string>,
  ): Promise<boolean> {
    try {
      const result = await this.bucket.put(key, body, {
        onlyIf: { etagDoesNotMatch: "*" },
        customMetadata,
      });
      return result !== null;
    } catch (error) {
      // Conditional failures are represented differently across workerd versions.
      const current = await this.bucket.head(key);
      if (current) return false;
      throw error;
    }
  }

  /** Reads existing metadata and ciphertext so a retried create can be authenticated semantically. */
  async readExisting(
    key: string,
  ): Promise<{ metadata: Record<string, string>; body: string } | null> {
    const object = await this.bucket.head(key);
    if (!object) return null;
    const body = await this.bucket.get(key);
    if (!body) return null;
    return { metadata: object.customMetadata ?? {}, body: await body.text() };
  }
}

/** D1 adapter recording every delivered job and maintaining independent monotonic domain cursors. */
export class D1OutboxProjection implements ProjectionPort {
  /** Binds a request-scoped projection adapter to the configured D1 database. */
  constructor(private readonly database: D1Database) {}

  /** Atomically records the per-job receipt and advances its independent monotonic cursor. */
  async apply(
    input: Parameters<ProjectionPort["apply"]>[0],
  ): Promise<"applied" | "duplicate"> {
    if (
      !/^op1_[A-Za-z0-9_-]{43}$/.test(input.jobRef) ||
      !/^[A-Za-z0-9._-]{1,120}$/.test(input.keyId) ||
      !["document", "runtime_fact", "nullmem"].includes(input.domain) ||
      !Number.isSafeInteger(input.generation) ||
      input.generation < 0 ||
      !Number.isSafeInteger(input.version) ||
      input.version < 0 ||
      !input.sourceHash ||
      !input.artifactHash ||
      !input.archiveKey
    )
      throw new Error("projection_invalid_identity");
    const metadataJson = serializeCanonicalJson(input.metadata);
    const existing = await this.database
      .prepare(
        `SELECT root_drop_id, branch_id, generation, domain, version, source_hash, artifact_hash, archive_key, metadata_json
       FROM state_plane_outbox_delivery_receipts WHERE job_ref = ? AND key_id = ?`,
      )
      .bind(input.jobRef, input.keyId)
      .first<{
        root_drop_id: string;
        branch_id: string;
        generation: number;
        domain: string;
        version: number;
        source_hash: string;
        artifact_hash: string;
        archive_key: string;
        metadata_json: string;
      }>();
    const tuple = [
      input.rootDropId,
      input.branchId,
      input.generation,
      input.domain,
      input.version,
      input.sourceHash,
      input.artifactHash,
      input.archiveKey,
      metadataJson,
    ];
    if (existing) {
      const prior = [
        existing.root_drop_id,
        existing.branch_id,
        existing.generation,
        existing.domain,
        existing.version,
        existing.source_hash,
        existing.artifact_hash,
        existing.archive_key,
        existing.metadata_json,
      ];
      if (JSON.stringify(prior) !== JSON.stringify(tuple))
        throw new Error("projection_job_identity_conflict");
      return "duplicate";
    }

    const now = Date.now();
    await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO state_plane_outbox_delivery_receipts
          (job_ref, key_id, root_drop_id, branch_id, generation, domain, version, source_hash, artifact_hash, archive_key, metadata_json, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(job_ref, key_id) DO NOTHING`,
        )
        .bind(
          input.jobRef,
          input.keyId,
          input.rootDropId,
          input.branchId,
          input.generation,
          input.domain,
          input.version,
          input.sourceHash,
          input.artifactHash,
          input.archiveKey,
          metadataJson,
          now,
        ),
      this.database
        .prepare(
          `INSERT INTO state_plane_outbox_projection_cursor
          (root_drop_id, branch_id, domain, generation, version, job_ref, key_id, source_hash, artifact_hash, archive_key, metadata_json, updated_at)
         SELECT root_drop_id, branch_id, domain, generation, version, job_ref, key_id, source_hash, artifact_hash, archive_key, metadata_json, ?
         FROM state_plane_outbox_delivery_receipts
         WHERE job_ref = ? AND key_id = ? AND root_drop_id = ? AND branch_id = ? AND generation = ? AND domain = ? AND version = ? AND source_hash = ? AND artifact_hash = ? AND archive_key = ? AND metadata_json = ?
         ON CONFLICT(root_drop_id, branch_id, domain) DO UPDATE SET
           generation=excluded.generation, version=excluded.version, job_ref=excluded.job_ref, key_id=excluded.key_id,
           source_hash=excluded.source_hash, artifact_hash=excluded.artifact_hash,
           archive_key=excluded.archive_key, metadata_json=excluded.metadata_json, updated_at=excluded.updated_at
         WHERE excluded.generation > state_plane_outbox_projection_cursor.generation
            OR (excluded.generation = state_plane_outbox_projection_cursor.generation AND excluded.version > state_plane_outbox_projection_cursor.version)
            OR (excluded.generation = state_plane_outbox_projection_cursor.generation AND excluded.version = state_plane_outbox_projection_cursor.version AND excluded.job_ref > state_plane_outbox_projection_cursor.job_ref)
            OR (excluded.generation = state_plane_outbox_projection_cursor.generation AND excluded.version = state_plane_outbox_projection_cursor.version AND excluded.job_ref = state_plane_outbox_projection_cursor.job_ref AND excluded.key_id > state_plane_outbox_projection_cursor.key_id)`,
        )
        .bind(
          now,
          input.jobRef,
          input.keyId,
          input.rootDropId,
          input.branchId,
          input.generation,
          input.domain,
          input.version,
          input.sourceHash,
          input.artifactHash,
          input.archiveKey,
          metadataJson,
        ),
    ]);

    const verified = await this.database
      .prepare(
        `SELECT root_drop_id, branch_id, generation, domain, version, source_hash, artifact_hash, archive_key, metadata_json
       FROM state_plane_outbox_delivery_receipts WHERE job_ref = ? AND key_id = ?`,
      )
      .bind(input.jobRef, input.keyId)
      .first<{
        root_drop_id: string;
        branch_id: string;
        generation: number;
        domain: string;
        version: number;
        source_hash: string;
        artifact_hash: string;
        archive_key: string;
        metadata_json: string;
      }>();
    if (!verified) throw new Error("projection_receipt_missing");
    const actual = [
      verified.root_drop_id,
      verified.branch_id,
      verified.generation,
      verified.domain,
      verified.version,
      verified.source_hash,
      verified.artifact_hash,
      verified.archive_key,
      verified.metadata_json,
    ];
    if (JSON.stringify(actual) !== JSON.stringify(tuple))
      throw new Error("projection_job_identity_conflict");
    return "applied";
  }
}

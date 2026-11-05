import { z } from "zod";
import {
  isDropBranchRecord,
  isDropSnapshotRecord,
  type DropBranchRecord,
  type DropSnapshotRecord,
} from "./branch";
import { isDropDiffEvent, isDropBranchRuntimeFact } from "./diff";
import { isNullMemRecord } from "../nullmem/validation";
import type {
  DropDiffEvent,
  DropDiffEventAcknowledgement,
  DropBranchRuntimeFact,
} from "./diff";
import type {
  BranchNullMemOutbox,
  BranchNullMemRecord,
} from "./branch-nullmem";

const token = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => value.trim() === value);
const hash = z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/);

/** A source authority's frozen, externally certified migration fence. */
export interface BranchMigrationFence {
  sourceId: string;
  sourceGeneration: number;
  sourceRevision: string;
  sourceHeadHash: string;
  certification: string;
}

/** Immutable identity and expected parity totals for one isolated staging import. */
export interface BranchMigrationManifest {
  migrationId: string;
  target: { rootDropId: string; branchId: string };
  routingVersion: 1;
  generation: number;
  fence: BranchMigrationFence;
  chunkCount: number;
  itemCount: number;
  payloadHash: string;
}

/** Exact materialized legacy snapshot. Full content is required; checkpoint-key-only history is rejected. */
export interface BranchMigrationSnapshot {
  snapshot: DropSnapshotRecord;
  content: string;
  contentHash?: string;
}

/** Source event paired with the original public acknowledgement identity, never a synthetic State Plane receipt. */
export interface BranchMigrationEvent {
  event: DropDiffEvent;
  acknowledgement: DropDiffEventAcknowledgement;
}

/** JSON-safe, typed migration records imported without replaying append operations. */
export type BranchMigrationRecord =
  | { kind: "branch"; value: DropBranchRecord }
  | { kind: "snapshot"; value: BranchMigrationSnapshot }
  | { kind: "event"; value: BranchMigrationEvent }
  | { kind: "runtime-fact"; value: DropBranchRuntimeFact }
  | {
      kind: "nullmem";
      value: {
        revision: number;
        records: BranchNullMemRecord[];
        outbox: BranchNullMemOutbox[];
      };
    };

/** One ordered, immutable payload chunk copied from the frozen source. */
export interface BranchMigrationChunk {
  migrationId: string;
  index: number;
  payload: BranchMigrationRecord[];
  payloadHash: string;
}

/** Durable phase and resume cursor for a fenced staging import. */
export interface BranchMigrationProgress {
  migrationId: string;
  phase:
    | "importing"
    | "verified"
    | "activated"
    | "rollback-pending"
    | "rolled-back"
    | "recovery-required";
  generation: number;
  nextChunk: number;
  chunkCount: number;
  itemCount: number;
  payloadHash: string;
}

/** Validates identifiers, expected totals, and caller-provided source fence fields. */
export function captureBranchMigrationManifest(
  value: unknown,
): BranchMigrationManifest {
  const schema = z
    .object({
      migrationId: token.regex(/^[A-Za-z0-9._:-]+$/),
      target: z.object({ rootDropId: token, branchId: token }).strict(),
      routingVersion: z.literal(1),
      generation: z.number().int().nonnegative(),
      fence: z
        .object({
          sourceId: token,
          sourceGeneration: z.number().int().nonnegative(),
          sourceRevision: token,
          sourceHeadHash: hash,
          certification: token,
        })
        .strict(),
      chunkCount: z.number().int().positive().max(8),
      itemCount: z.number().int().nonnegative().max(10_000),
      payloadHash: hash,
    })
    .strict();
  const result = schema.safeParse(value);
  if (
    !result.success ||
    result.data.generation !== result.data.fence.sourceGeneration + 1
  )
    throw new Error("invalid_branch_migration_manifest");
  return structuredClone(result.data) as BranchMigrationManifest;
}

/** Validates and defensively captures one content-addressed source chunk. */
export async function captureBranchMigrationChunk(
  value: unknown,
): Promise<BranchMigrationChunk> {
  const schema = z
    .object({
      migrationId: token,
      index: z.number().int().nonnegative(),
      payload: z
        .array(
          z.discriminatedUnion("kind", [
            z
              .object({
                kind: z.literal("branch"),
                value: z.record(z.string(), z.unknown()),
              })
              .strict(),
            z
              .object({
                kind: z.literal("snapshot"),
                value: z
                  .object({
                    snapshot: z.record(z.string(), z.unknown()),
                    content: z.string(),
                    contentHash: hash.optional(),
                  })
                  .strict(),
              })
              .strict(),
            z
              .object({
                kind: z.literal("event"),
                value: z
                  .object({
                    event: z.record(z.string(), z.unknown()),
                    acknowledgement: z.record(z.string(), z.unknown()),
                  })
                  .strict(),
              })
              .strict(),
            z
              .object({
                kind: z.literal("runtime-fact"),
                value: z.record(z.string(), z.unknown()),
              })
              .strict(),
            z
              .object({
                kind: z.literal("nullmem"),
                value: z
                  .object({
                    revision: z.number().int().nonnegative(),
                    records: z.array(z.record(z.string(), z.unknown())),
                    outbox: z.array(z.record(z.string(), z.unknown())),
                  })
                  .strict(),
              })
              .strict(),
          ]),
        )
        .max(500),
      payloadHash: hash,
    })
    .strict();
  const result = schema.safeParse(value);
  if (!result.success) throw new Error("invalid_branch_migration_chunk");
  const chunk = structuredClone(result.data);
  if (
    chunk.payload.length > 500 ||
    migrationChunkBytes(chunk.payload) > 1_000_000
  )
    throw new Error("branch_migration_chunk_size_invalid");
  const actual = await hashMigrationPayload(chunk.payload);
  if (actual !== chunk.payloadHash)
    throw new Error("branch_migration_chunk_hash_mismatch");
  const payload: BranchMigrationRecord[] = chunk.payload.map((record) => {
    switch (record.kind) {
      case "branch":
        if (isDropBranchRecord(record.value))
          return { kind: record.kind, value: record.value };
        break;
      case "snapshot":
        if (isDropSnapshotRecord(record.value.snapshot))
          return {
            kind: record.kind,
            value: { ...record.value, snapshot: record.value.snapshot },
          };
        break;
      case "event": {
        const acknowledgement = z
          .object({
            eventId: z.string().min(1),
            seq: z.number().int().nonnegative(),
            snapshotId: z.number().int().nonnegative(),
            status: z.enum(["accepted", "duplicate"]),
          })
          .strict()
          .safeParse(record.value.acknowledgement);
        if (isDropDiffEvent(record.value.event) && acknowledgement.success)
          return {
            kind: record.kind,
            value: {
              event: record.value.event,
              acknowledgement: acknowledgement.data,
            },
          };
        break;
      }
      case "runtime-fact":
        if (isDropBranchRuntimeFact(record.value))
          return { kind: record.kind, value: record.value };
        break;
      case "nullmem": {
        if (record.value.revision !== 0 || record.value.outbox.length) break;
        const records = record.value.records.map((value) => {
          if (!isNullMemRecord(value) || value.kind === "capability")
            throw new Error("invalid_branch_migration_record");
          return value;
        });
        return {
          kind: record.kind,
          value: { revision: 0, records, outbox: [] },
        };
      }
    }
    throw new Error("invalid_branch_migration_record");
  });
  return { ...chunk, payload };
}

/** UTF-8 byte charge persisted with each chunk; staged payloads are limited to eight million bytes. */
export function migrationChunkBytes(payload: readonly unknown[]): number {
  return new TextEncoder().encode(JSON.stringify(payload)).byteLength;
}

/** Stable hash for JSON-safe migration payloads; UTF-16 content is preserved by JSON encoding. */
export async function hashMigrationPayload(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const binary = Array.from(new Uint8Array(digest), (byte) =>
    String.fromCharCode(byte),
  ).join("");
  return `sha256:${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
}

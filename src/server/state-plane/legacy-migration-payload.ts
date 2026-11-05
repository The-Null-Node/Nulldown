import { BranchStateError } from "../../../shared/drop/branch-state";
import {
  hashMigrationPayload,
  type BranchMigrationChunk,
  type BranchMigrationManifest,
  type BranchMigrationRecord,
} from "../../../shared/drop/branch-migration";
import type { CapturedLegacyBranch } from "./legacy-migration-source";

/** Bounded source payload and immutable manifest for one request-lifetime export. */
export interface LegacyMigrationPayload {
  manifest: BranchMigrationManifest;
  chunks: BranchMigrationChunk[];
}

/**
 * Converts a frozen capture to typed import records without replaying mutations.
 * Public event acknowledgements are reconstructed from original snapshot membership;
 * legacy memory has no mutation revision, so its current records form revision zero.
 */
export async function buildLegacyMigrationPayload(
  capture: CapturedLegacyBranch,
  identity: {
    migrationId: string;
    sourceId: string;
    sourceGeneration: number;
    certification: string;
  },
): Promise<LegacyMigrationPayload> {
  if (!Number.isSafeInteger(identity.sourceGeneration + 1))
    throw new BranchStateError("invalid_command");
  const snapshotsByEvent = new Map<string, number>();
  for (const { snapshot } of capture.snapshots)
    for (const eventId of snapshot.eventIds) {
      if (snapshotsByEvent.has(eventId))
        throw new BranchStateError("state_corrupt");
      snapshotsByEvent.set(eventId, snapshot.snapshotId);
    }
  const records: BranchMigrationRecord[] = [
    { kind: "branch", value: capture.branch },
    ...capture.snapshots.map(
      ({ snapshot, content }): BranchMigrationRecord => ({
        kind: "snapshot",
        value: { snapshot, content },
      }),
    ),
    ...capture.events.map((event): BranchMigrationRecord => {
      const snapshotId = snapshotsByEvent.get(event.eventId);
      if (snapshotId === undefined || event.seq === undefined)
        throw new BranchStateError("state_corrupt");
      return {
        kind: "event",
        value: {
          event,
          acknowledgement: {
            eventId: event.eventId,
            seq: event.seq,
            snapshotId,
            status: "accepted",
          },
        },
      };
    }),
    ...capture.runtimeFacts.map((value): BranchMigrationRecord => ({
      kind: "runtime-fact",
      value,
    })),
    {
      kind: "nullmem",
      value: {
        revision: 0,
        records: capture.memoryRecords.map((record) => {
          if (record.kind === "capability")
            throw new BranchStateError("capability_unsupported");
          return record;
        }),
        outbox: [],
      },
    },
  ];
  const chunks: BranchMigrationChunk[] = [];
  let payload: BranchMigrationRecord[] = [],
    bytes = 2;
  const flush = async () => {
    if (!payload.length) return;
    chunks.push({
      migrationId: identity.migrationId,
      index: chunks.length,
      payload,
      payloadHash: await hashMigrationPayload(payload),
    });
    payload = [];
    bytes = 2;
  };
  for (const record of records) {
    const size =
      new TextEncoder().encode(JSON.stringify(record)).byteLength + 1;
    if (size + 2 > 900_000)
      throw new BranchStateError("capability_unsupported");
    if (payload.length >= 200 || bytes + size > 900_000) await flush();
    payload.push(record);
    bytes += size;
  }
  await flush();
  return {
    chunks,
    manifest: {
      migrationId: identity.migrationId,
      target: {
        rootDropId: capture.branch.rootDropId,
        branchId: capture.branch.branchId,
      },
      routingVersion: 1,
      generation: identity.sourceGeneration + 1,
      fence: {
        sourceId: identity.sourceId,
        sourceGeneration: identity.sourceGeneration,
        sourceRevision: capture.branchEtag,
        sourceHeadHash: capture.captureHash,
        certification: identity.certification,
      },
      chunkCount: chunks.length,
      itemCount: records.length,
      payloadHash: await hashMigrationPayload(
        chunks.map((chunk) => chunk.payloadHash),
      ),
    },
  };
}

import { createBranchRepository } from "../../../functions/api/_lib/branches/storage/repository";
import { createBranchDiffRepository } from "../../../functions/api/_lib/branches/storage/diff-log";
import { createBranchRuntimeFactLogRepository } from "../../../functions/api/_lib/branches/storage/runtime-fact-log";
import { readBranchContent } from "../../../functions/api/_lib/branches/content/replay";
import {
  isDropSnapshotRecord,
  type DropBranchRecord,
  type DropSnapshotRecord,
} from "../../../shared/drop/branch";
import type {
  DropDiffEvent,
  DropBranchRuntimeFact,
} from "../../../shared/drop/diff";
import {
  BranchStateError,
  BranchStateQuery,
  type BranchStateTarget,
} from "../../../shared/drop/branch-state";
import { hashNulldownSourceContent } from "../../../shared/drop/resolved/hash";
import { isNullMemRecord } from "../../../shared/nullmem/validation";
import type { NullMemRecord } from "../../../shared/nullmem/records";
import { serializeCanonicalJson } from "../../../shared/drop/types";
import { hashMigrationPayload } from "../../../shared/drop/branch-migration";
import type { BlobObjectStore, SqlMetadataStore } from "../ports";

/** Exact legacy snapshot plus its hydrated content and separately derived validation hash. */
export interface CapturedLegacySnapshot {
  snapshot: DropSnapshotRecord;
  content: string;
  contentHash: string;
}

/** Request-lifetime frozen source capture; public records retain their historical fields. */
export interface CapturedLegacyBranch {
  branch: DropBranchRecord;
  branchEtag: string;
  snapshots: CapturedLegacySnapshot[];
  events: DropDiffEvent[];
  runtimeFacts: DropBranchRuntimeFact[];
  memoryRecords: NullMemRecord[];
  captureHash: string;
}

/** Explicit bounded exporter dependencies; the trusted gate must cover every writer from creation. */
export interface LegacyMigrationSourceOptions {
  blobs: BlobObjectStore;
  sql: SqlMetadataStore;
  target: BranchStateTarget;
  assertFrozen(): Promise<void>;
  maxSnapshots?: number;
  maxEvents?: number;
  maxRuntimeFacts?: number;
  maxMemoryRecords?: number;
  maxBytes?: number;
}

/**
 * Captures canonical R2 history and exact-scope SQL memory while source admissions
 * are durably frozen. Derived D1 document projections are deliberately not trusted
 * for export. Large inputs reject explicitly rather than yielding a partial import.
 */
export async function captureLegacyMigrationSource(
  options: LegacyMigrationSourceOptions,
): Promise<CapturedLegacyBranch> {
  const { target } = BranchStateQuery.head({
    target: options.target,
    placement: { routingVersion: 1, generation: 0 },
  });
  const limits = {
    snapshots: options.maxSnapshots ?? 256,
    events: options.maxEvents ?? 10_000,
    facts: options.maxRuntimeFacts ?? 10_000,
    memory: options.maxMemoryRecords ?? 5_000,
    bytes: options.maxBytes ?? 8 * 1024 * 1024,
  };
  if (
    Object.values(limits).some(
      (value) => !Number.isSafeInteger(value) || value < 1,
    )
  )
    throw new BranchStateError("invalid_command");
  await options.assertFrozen();
  const unsupported = await options.sql
    .prepare(
      "SELECT 1 AS present FROM resolved_priority_facts WHERE root_drop_id=? AND branch_id=? LIMIT 1",
    )
    .bind(target.rootDropId, target.branchId)
    .first();
  const globals = await options.sql
    .prepare(
      "SELECT 1 AS present FROM nullmem_records WHERE root_drop_id='' AND branch_id='' LIMIT 1",
    )
    .first();
  if (unsupported || globals)
    throw new BranchStateError("capability_unsupported");
  const repository = createBranchRepository({ blobs: options.blobs });
  const initial = await repository.readBranchWithEtag(
    target.rootDropId,
    target.branchId,
  );
  if (!initial) throw new BranchStateError("branch_not_found");
  const branch = initial.branch;
  if (
    branch.rootDropId !== target.rootDropId ||
    branch.branchId !== target.branchId ||
    branch.status !== "active" ||
    branch.headSnapshotId + 1 > limits.snapshots ||
    !Number.isSafeInteger(branch.headEventSeq) ||
    branch.headEventSeq! < -1 ||
    branch.headEventSeq! + 1 > limits.events
  )
    throw new BranchStateError("capability_unsupported");
  let bytes = 0;
  const charge = (value: unknown) => {
    bytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (bytes > limits.bytes)
      throw new BranchStateError("capability_unsupported");
  };
  charge(branch);
  const snapshots: CapturedLegacySnapshot[] = [];
  for (let snapshotId = 0; snapshotId <= branch.headSnapshotId; snapshotId++) {
    await options.assertFrozen();
    const snapshot = await repository.readSnapshot(
      target.rootDropId,
      target.branchId,
      snapshotId,
    );
    if (
      !snapshot ||
      !isDropSnapshotRecord(snapshot) ||
      snapshot.snapshotId !== snapshotId ||
      snapshot.rootDropId !== target.rootDropId ||
      snapshot.branchId !== target.branchId ||
      snapshot.parentSnapshotId !== (snapshotId === 0 ? null : snapshotId - 1)
    )
      throw new BranchStateError("state_corrupt");
    const content = await readBranchContent(
      options.blobs,
      target.rootDropId,
      target.branchId,
      snapshotId,
    );
    if (content === null || content.length !== snapshot.textLength)
      throw new BranchStateError("state_corrupt");
    const contentHash = await hashNulldownSourceContent(content);
    if (
      snapshot.sourceContentHash &&
      snapshot.sourceContentHash !== contentHash
    )
      throw new BranchStateError("state_corrupt");
    const captured = { snapshot, content, contentHash };
    charge(captured);
    snapshots.push(captured);
  }
  const diffRepository = createBranchDiffRepository({ blobs: options.blobs });
  const events: DropDiffEvent[] = [];
  const eventIds = new Set<string>();
  for (let seq = 0; seq <= branch.headEventSeq!; seq++) {
    if (seq % 200 === 0) await options.assertFrozen();
    const event = await diffRepository.readBranchDiffEventBySeq(
      target.rootDropId,
      target.branchId,
      seq,
    );
    if (
      !event ||
      event.seq !== seq ||
      event.dropId !== target.rootDropId ||
      eventIds.has(event.eventId)
    )
      throw new BranchStateError("state_corrupt");
    eventIds.add(event.eventId);
    charge(event);
    events.push(event);
  }
  const runtimeRepository = createBranchRuntimeFactLogRepository({
    blobs: options.blobs,
  });
  const factHead = await runtimeRepository.readBranchHeadRuntimeFactSeq(
    target.rootDropId,
    target.branchId,
  );
  if (!Number.isSafeInteger(factHead) || factHead < -1)
    throw new BranchStateError("state_corrupt");
  if (factHead + 1 > limits.facts)
    throw new BranchStateError("capability_unsupported");
  const runtimeFacts: DropBranchRuntimeFact[] = [];
  while (runtimeFacts.length <= factHead) {
    await options.assertFrozen();
    const page = await runtimeRepository.pollBranchRuntimeFactsSince(
      target.rootDropId,
      target.branchId,
      runtimeFacts.length - 1,
      Math.min(200, factHead + 1 - runtimeFacts.length),
    );
    if (!page.facts.length || page.headSeq !== factHead)
      throw new BranchStateError("state_corrupt");
    for (const fact of page.facts) {
      if (
        fact.seq !== runtimeFacts.length ||
        fact.rootDropId !== target.rootDropId ||
        fact.branchId !== target.branchId ||
        fact.seq > factHead
      )
        throw new BranchStateError("state_corrupt");
      charge(fact);
      runtimeFacts.push(fact);
    }
  }
  const memoryRecords: NullMemRecord[] = [];
  let kind = "",
    recordId = "";
  while (true) {
    await options.assertFrozen();
    const result = await options.sql
      .prepare(
        "SELECT record_kind,record_id,record_json FROM nullmem_records WHERE root_drop_id=? AND branch_id=? AND (record_kind>? OR (record_kind=? AND record_id>?)) ORDER BY record_kind,record_id LIMIT 200",
      )
      .bind(target.rootDropId, target.branchId, kind, kind, recordId)
      .all();
    const rows = result.results ?? [];
    if (!rows.length) break;
    for (const row of rows) {
      if (typeof row.record_json !== "string")
        throw new BranchStateError("state_corrupt");
      let value: unknown;
      try {
        value = JSON.parse(row.record_json);
      } catch {
        throw new BranchStateError("state_corrupt");
      }
      if (
        !isNullMemRecord(value) ||
        value.kind !== row.record_kind ||
        value.recordId !== row.record_id
      )
        throw new BranchStateError("state_corrupt");
      if (value.kind === "capability")
        throw new BranchStateError("capability_unsupported");
      if (
        value.rootDropId !== target.rootDropId ||
        value.branchId !== target.branchId
      )
        throw new BranchStateError("state_corrupt");
      charge(value);
      memoryRecords.push(value);
      if (memoryRecords.length > limits.memory)
        throw new BranchStateError("capability_unsupported");
      kind = value.kind;
      recordId = value.recordId;
    }
    if (rows.length < 200) break;
  }
  await options.assertFrozen();
  const final = await repository.readBranchWithEtag(
    target.rootDropId,
    target.branchId,
  );
  if (
    !final ||
    final.etag !== initial.etag ||
    serializeCanonicalJson(final.branch) !== serializeCanonicalJson(branch) ||
    (await runtimeRepository.readBranchHeadRuntimeFactSeq(
      target.rootDropId,
      target.branchId,
    )) !== factHead
  )
    throw new BranchStateError("routing_placement_mismatch");
  const captured = {
    branch,
    branchEtag: initial.etag,
    snapshots,
    events,
    runtimeFacts,
    memoryRecords,
  };
  const captureHash = await hashMigrationPayload(captured);
  await options.assertFrozen();
  return { ...captured, captureHash };
}

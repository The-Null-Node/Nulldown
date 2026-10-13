import type {
  DropBranchRecord,
  DropSnapshotRecord,
} from "../../../shared/drop/branch";
import type { DropDiffEvent } from "../../../shared/drop/diff";
import type { DropDiffPollResponse } from "../../../shared/drop/diff";
import type {
  BranchMemoryService,
  ServerNulleditAppendRequest,
  ServerNulleditAppendResult,
} from "../runtime";

/** Request-scoped memory behavior, including query-time freshness and stale-check reads. */
export interface BranchMemoryStatePlane {
  /** Injected query and mutation capability; callers retain authorization and visibility rules. */
  memory: BranchMemoryService;
}

/** Authorized append commands for one request, including durable replay acknowledgements. */
export interface BranchDiffCommands {
  /** Accepts events through the existing fenced commit and snapshotter orchestration. */
  appendDiffEvents(
    request: ServerNulleditAppendRequest,
  ): Promise<ServerNulleditAppendResult>;
}

/** Validated poll input for an already authorized branch and optional sensitive fact stream. */
export interface BranchDiffPollRequest {
  /** Canonical route root; do not substitute a stored record's root during polling. */
  rootDropId: string;
  branch: DropBranchRecord;
  cursor: string | null;
  excludeClient?: string;
  limit: number;
  factCursor?: string;
  factLimit: number;
}

/** Poll response and operational counts produced by the request-scoped legacy reader. */
export interface BranchDiffPollResult {
  response: DropDiffPollResponse;
  totalStored: number;
  totalFacts?: number;
}

/** Authorized event/fact stream reads for one request; does not resolve or create branches. */
export interface BranchDiffPolling {
  /** Polls both streams with their existing cursor, exclusion, and latest-handshake semantics. */
  poll(request: BranchDiffPollRequest): Promise<BranchDiffPollResult>;
}

/** Branch timeline operations for one application request; callers own access checks. */
export interface BranchTimelineCapability {
  /** Reads a branch without creating or upgrading it. */
  readBranch(
    rootDropId: string,
    branchId: string,
  ): Promise<DropBranchRecord | null>;
  /** Lists timelines in the legacy creation order; callers apply visibility filtering. */
  listBranchesForRoot(rootDropId: string): Promise<DropBranchRecord[]>;
  /** Resolves an actor's timeline, retaining legacy creation and heap-upgrade semantics. */
  resolveForActor(
    rootDropId: string,
    accountId: string | null,
    clientId: string | null,
  ): Promise<{ branch: DropBranchRecord; created: boolean }>;
}

/** Snapshot reads and replay for one request, without exposing checkpoint storage keys. */
export interface BranchSnapshotCapability {
  /** Reads the inclusive event range used for snapshot change provenance. */
  readEventsBySeqRange(
    rootDropId: string,
    branchId: string,
    startSeq: number,
    endSeq: number,
  ): Promise<DropDiffEvent[]>;
  /** Reads exact snapshot metadata, retaining missing-record semantics. */
  readSnapshot(
    rootDropId: string,
    branchId: string,
    snapshotId: number,
  ): Promise<DropSnapshotRecord | null>;
  /** Lists snapshots in ascending snapshot-id order. */
  listSnapshotsForBranch(
    rootDropId: string,
    branchId: string,
  ): Promise<DropSnapshotRecord[]>;
  /** Materializes an exact snapshot using the backend's checkpoint and replay fallbacks. */
  readContent(
    rootDropId: string,
    branchId: string,
    snapshotId: number,
  ): Promise<string | null>;
}

/** Explicit maintenance operations for an already authorized administrative request. */
export interface BranchMaintenanceCapability {
  /** Pages existing branches using the legacy backend cursor. */
  listBranchesForRootPage(
    rootDropId: string,
    limit: number,
    cursor?: string,
  ): Promise<{
    branches: DropBranchRecord[];
    cursor: string | null;
    truncated: boolean;
  }>;
  /** Upgrades an existing branch under its legacy mutation fence. */
  backfillSnapshotHeap(
    rootDropId: string,
    branchId: string,
  ): Promise<DropBranchRecord | null>;
}

/** Request-scoped application routing boundary for branch timelines and snapshots. */
export interface BranchStatePlane {
  /** Event and optional sensitive runtime-fact polling. */
  diffs: BranchDiffPolling;
  /** Timeline discovery and actor resolution. */
  branches: BranchTimelineCapability;
  /** Snapshot listing and content materialization. */
  snapshots: BranchSnapshotCapability;
  /** Administrative timeline maintenance; never run during gateway construction. */
  maintenance: BranchMaintenanceCapability;
}

import type {
  DropBranchRecord,
  DropSnapshotRecord,
} from "../../shared/drop/branch";
import type { DropDiffEvent } from "../../shared/drop/diff";
import type {
  NulleditSnapshotterDispatchOptions,
} from "./nulledit";
import type { VoidDataStore } from "./ports";

/** Request passed through the VoidProvider Nulledit append facade. */
export interface VoidProviderNulleditAppendRequest
  extends NulleditSnapshotterDispatchOptions {
  /** Branch that should accept the diff events. */
  branch: DropBranchRecord;
  /** Diff events to deduplicate, sequence, persist, and snapshot. */
  events: DropDiffEvent[];
}

/** Result returned by the VoidProvider Nulledit append facade. */
export interface VoidProviderNulleditAppendResult {
  /** Updated branch after the append, or current branch for fully deduplicated writes. */
  branch: DropBranchRecord;
  /** Created snapshot, or null when every input event was already stored. */
  snapshot: DropSnapshotRecord | null;
  /** Materialized branch content at the returned branch head. */
  content: string;
  /** Events accepted during this append with durable sequence numbers assigned. */
  acceptedEvents: DropDiffEvent[];
  /** Number of input events ignored because they were duplicates. */
  deduplicatedCount: number;
  /** Total number of branch events stored after the append. */
  totalStored: number;
}

/** Nulledit operations exposed through the app-facing VoidProvider facade. */
export interface VoidProviderNulledit {
  /** Appends diff events to a branch and dispatches Nulledit snapshotters. */
  appendDiffEvents(
    request: VoidProviderNulleditAppendRequest,
  ): Promise<VoidProviderNulleditAppendResult>;
}

/** App-facing server facade composed from storage, crypto, and Nulledit services. */
export interface VoidProvider {
  /** Functional persistence, indexing, caching, and locking boundary. */
  data: VoidDataStore;
  /** Shared edit, snapshot, and query engine. */
  nulledit: VoidProviderNulledit;
}

/** Dependencies required to compose a VoidProvider. */
export interface CreateVoidProviderOptions {
  /** Functional datastore implementation for the current platform. */
  data: VoidDataStore;
  /** Nulledit facade implementation for the current platform. */
  nulledit: VoidProviderNulledit;
}

/** Creates the app-facing VoidProvider facade from platform-neutral capabilities. */
export const createVoidProvider = ({
  data,
  nulledit,
}: CreateVoidProviderOptions): VoidProvider => ({
  data,
  nulledit,
});

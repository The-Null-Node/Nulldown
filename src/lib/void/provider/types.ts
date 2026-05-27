import type {
  DropGraph,
  DropPayload,
  DropUnlockPolicy,
  DropVisibility,
} from "../../../../shared/drop/types";
import type {
  DropCrudRecord,
  VoidProviderScope,
} from "../storage/types";

export type {
  DropCrudRecord,
  StoredDropRecord,
  VoidProviderScope,
  VoidStorage,
  VoidStorageCreateOptions,
} from "../storage/types";

/** Options accepted when the void runtime creates or upserts a drop. */
export interface VoidCreateOptions {
  id?: string;
  upsert?: boolean;
  expectedRevision?: string;
  visibility?: DropVisibility;
  unlockPolicy?: DropUnlockPolicy;
}

/** Options for sealed-envelope synchronization between provider ports. */
export interface VoidSyncOptions {
  dropId?: string;
}

/** Progress emitted while sealed records sync between void provider ports. */
export interface VoidSyncProgress {
  phase: "start" | "record" | "complete";
  total: number;
  completed: number;
  dropId?: string;
}

/** Summary returned after sealed records sync between void provider ports. */
export interface VoidSyncResult {
  total: number;
  synced: number;
  skipped: number;
  targetScope: VoidProviderScope;
}

/** Options for creating an already-sealed CRUD record. */
export interface DropCrudCreateOptions {
  upsert?: boolean;
  expectedRevision?: string;
}

/** Minimal CRUD shape used by sealed drop repositories. */
export interface Crud<T, TOptions> {
  // single options for now, must expand later if needed.
  create: (record: T, options?: TOptions) => Promise<void>;
  get: (id: string) => Promise<DropCrudRecord | null>;
  update: (id: string, record: Partial<DropCrudRecord>) => Promise<void>;
  delete: (id: string) => Promise<void>;
  list: () => Promise<DropCrudRecord[]>;
}

/** Sealed drop CRUD port used by sync and low-level provider operations. */
export interface DropCrud extends Crud<DropCrudRecord, DropCrudCreateOptions> {
  create: (
    record: DropCrudRecord,
    options?: DropCrudCreateOptions,
  ) => Promise<void>;

  get: (id: string) => Promise<DropCrudRecord | null>;
  update: (id: string, record: Partial<DropCrudRecord>) => Promise<void>;
  delete: (id: string) => Promise<void>;
  list: () => Promise<DropCrudRecord[]>;
}

/** Grouped sealed CRUD capabilities exposed by a provider port. */
export interface DropCrudContext {
  drops: DropCrud;
}

/** Resolves lineage for drops opened through the void runtime. */
export interface VoidGraph {
  resolve: (
    id: string,
    getDrop: (dropId: string) => Promise<DropPayload | null>,
  ) => Promise<DropGraph>;
}

/**
 * Child local, remote, or server capability port under a `VoidProvider`.
 *
 * Ports expose plaintext operations to the master runtime but sync using sealed
 * CRUD records so target ports never need source plaintext.
 */
export interface DropProviderPort {
  scope: VoidProviderScope;
  crud: DropCrudContext;
  create: (
    payload: DropPayload,
    options?: VoidCreateOptions,
  ) => Promise<{ id: string; url: string; scope: VoidProviderScope }>;
  get: (id: string) => Promise<DropPayload | null>;
  resolveGraph: (id: string) => Promise<DropGraph>;
  sync: (
    target: DropProviderPort,
    options?: VoidSyncOptions,
    onProgress?: (progress: VoidSyncProgress) => void,
  ) => Promise<VoidSyncResult>;
}

/** Master app-facing facade for drop runtime operations. */
export interface VoidProvider extends DropProviderPort {}

/** Registry that selects the appropriate void provider by drop id. */
export interface VoidProviderRegistry {
  local: VoidProvider;
  remote: VoidProvider;
  forDropId: (id: string) => VoidProvider;
}

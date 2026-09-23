import type {
  DropGraph,
  DropPayload,
  DropUnlockPolicy,
  DropVisibility,
} from "../../../../shared/drop/types";
import type { DropCrudRecord, DropProviderPortScope } from "../storage/types";
export type {
  DropCrudRecord,
  DropProviderPortScope,
  StoredDropRecord,
  DropStorage,
  DropStorageCreateOptions,
} from "../storage/types";

/** Options accepted when a drop provider port creates or upserts a drop. */
export interface DropProviderCreateOptions {
  id?: string;
  upsert?: boolean;
  expectedRevision?: string;
  visibility?: DropVisibility;
  unlockPolicy?: DropUnlockPolicy;
}

/** Options for sealed-envelope synchronization between drop provider ports. */
export interface DropProviderSyncOptions {
  dropId?: string;
}

/** Progress emitted while sealed records sync between drop provider ports. */
export interface DropProviderSyncProgress {
  phase: "start" | "record" | "complete";
  total: number;
  completed: number;
  dropId?: string;
}

/** Summary returned after sealed records sync between drop provider ports. */
export interface DropProviderSyncResult {
  total: number;
  synced: number;
  skipped: number;
  targetScope: DropProviderPortScope;
}

/** Options for creating an already-sealed CRUD record. */
export interface DropCrudCreateOptions {
  upsert?: boolean;
  expectedRevision?: string;
}

/** Sealed drop CRUD port used by sync and low-level provider operations. */
export interface DropCrud {
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

/** Resolves lineage for drops opened through a browser drop provider port. */
export interface DropGraphResolver {
  resolve: (
    id: string,
    getDrop: (dropId: string) => Promise<DropPayload | null>,
  ) => Promise<DropGraph>;
}

/**
 * Local or remote browser capability for plaintext drop operations.
 *
 * Ports sync using sealed CRUD records so target ports never need source
 * plaintext.
 */
export interface DropProviderPort {
  scope: DropProviderPortScope;
  crud: DropCrudContext;
  create: (
    payload: DropPayload,
    options?: DropProviderCreateOptions,
  ) => Promise<{ id: string; url: string; scope: DropProviderPortScope }>;
  get: (id: string) => Promise<DropPayload | null>;
  resolveGraph: (id: string) => Promise<DropGraph>;
  sync: (
    target: DropProviderPort,
    options?: DropProviderSyncOptions,
    onProgress?: (progress: DropProviderSyncProgress) => void,
  ) => Promise<DropProviderSyncResult>;
}

/** Registry that selects the appropriate child provider port by drop id. */
export interface DropProviderPortRegistry {
  local: DropProviderPort;
  remote: DropProviderPort;
  forDropId: (id: string) => DropProviderPort;
}

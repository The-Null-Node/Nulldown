import type { DropEnvelope, DropPayload } from "../../../../shared/drop/types";

/** Runtime backend scope used by void storage and drop provider ports. */
export type DropProviderPortScope = "local" | "remote";

/** Sealed drop record stored by provider-port CRUD operations. */
export interface DropCrudRecord {
  id: string;
  envelope: DropEnvelope;
  createdAt: number;
  updatedAt: number;
  revision?: string | null;
}

/** Stored record loaded from a void storage backend. */
export type StoredDropRecord =
  | {
      kind: "sealed";
      id: string;
      envelope: DropEnvelope;
      createdAt: number;
      updatedAt: number;
      revision?: string | null;
    }
  | { kind: "legacy"; id: string; payload: DropPayload };

/** Options for storing a sealed envelope in a void storage backend. */
export interface DropStorageCreateOptions {
  id?: string;
  upsert?: boolean;
  expectedRevision?: string;
}

/**
 * Sealed persistence boundary for the void runtime.
 *
 * Implementations may use IndexedDB, HTTP, or R2, but must only persist sealed
 * envelopes and must not receive plaintext payloads or own cryptographic work.
 */
export interface DropStorage {
  scope: DropProviderPortScope;
  create: (
    envelope: DropEnvelope,
    options?: DropStorageCreateOptions,
  ) => Promise<{ id: string; url: string }>;
  get: (id: string) => Promise<StoredDropRecord | null>;
  list: () => Promise<DropCrudRecord[]>;
  delete: (id: string) => Promise<void>;
}

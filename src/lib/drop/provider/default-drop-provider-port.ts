import type { DropPayload } from "../../../../shared/drop/types";
import type {
  DropCrudContext,
  DropCrudRecord,
  DropProviderCreateOptions,
  DropProviderPort,
  DropProviderPortScope,
  DropProviderSyncOptions,
  DropProviderSyncProgress,
  DropProviderSyncResult,
  DropGraphResolver,
  DropStorage,
} from "./types";
import type {
  DropCrypto,
  DropSealOptions,
} from "../../crypto/browser-drop-crypto";

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    const prefix =
      error.name && error.name !== "Error" ? `${error.name}: ` : "";
    return `${prefix}${error.message}`.trim();
  }

  return String(error);
};

/**
 * Default child provider port composed from storage, crypto, and graph
 * capabilities.
 */
export class DefaultDropProviderPort implements DropProviderPort {
  readonly scope: DropProviderPortScope;
  readonly crud: DropCrudContext;

  constructor(
    private readonly storage: DropStorage,
    private readonly cryptoPort: DropCrypto,
    private readonly graphPort: DropGraphResolver,
  ) {
    this.scope = storage.scope;
    this.crud = {
      drops: {
        create: async (record, options = {}) => {
          await this.storage.create(record.envelope, {
            id: record.id,
            upsert: options.upsert,
            expectedRevision: options.expectedRevision,
          });
        },
        get: async (id) => {
          const record = await this.storage.get(id);
          if (!record || record.kind !== "sealed") {
            return null;
          }

          return {
            id: record.id,
            envelope: record.envelope,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            revision: record.revision,
          };
        },
        update: async (id, record) => {
          const nextEnvelope = record.envelope;
          if (!nextEnvelope) {
            return;
          }

          await this.storage.create(nextEnvelope, {
            id,
            upsert: true,
          });
        },
        delete: async (id) => this.storage.delete(id),
        list: async () => this.storage.list(),
      },
    };
  }

  async create(
    payload: DropPayload,
    options: DropProviderCreateOptions = {},
  ): Promise<{ id: string; url: string; scope: DropProviderPortScope }> {
    const sealOptions: DropSealOptions = {
      visibility: options.visibility,
      unlockPolicy: options.unlockPolicy,
    };
    const envelope = await this.cryptoPort.seal(payload, sealOptions);

    const created = await this.storage.create(envelope, {
      id: options.id,
      upsert: options.upsert,
      expectedRevision: options.expectedRevision,
    });

    return {
      ...created,
      scope: this.scope,
    };
  }

  async get(id: string): Promise<DropPayload | null> {
    const stored = await this.storage.get(id);
    if (!stored) {
      return null;
    }

    if (stored.kind === "legacy") {
      return stored.payload;
    }

    try {
      return await this.cryptoPort.open(stored.envelope, { dropId: stored.id });
    } catch (error) {
      const requestedSuffix = stored.id === id ? "" : ` (requested as "${id}")`;
      console.error(
        `[drop-provider] Failed to open ${this.scope} drop "${stored.id}"${requestedSuffix}:`,
        error,
      );
      throw new Error(
        `Failed to decrypt ${this.scope} drop "${stored.id}"${requestedSuffix}: ${getErrorMessage(
          error,
        )}`,
      );
    }
  }

  async resolveGraph(id: string) {
    return this.graphPort.resolve(id, (dropId) => this.get(dropId));
  }

  async sync(
    target: DropProviderPort,
    options: DropProviderSyncOptions = {},
    onProgress?: (progress: DropProviderSyncProgress) => void,
  ): Promise<DropProviderSyncResult> {
    const sourceRecords = options.dropId
      ? [await this.crud.drops.get(options.dropId)].filter(
          (record): record is DropCrudRecord => Boolean(record),
        )
      : await this.crud.drops.list();

    const total = sourceRecords.length;
    let completed = 0;
    let skipped = 0;

    onProgress?.({ phase: "start", total, completed, dropId: options.dropId });

    for (const record of sourceRecords) {
      try {
        // Sync works on already-sealed envelopes so the target provider never needs plaintext.
        await target.crud.drops.create(record, { upsert: true });
        completed += 1;
      } catch (error) {
        skipped += 1;
        console.error(
          `Failed syncing drop "${record.id}" to ${target.scope}:`,
          error,
        );
      }

      onProgress?.({
        phase: "record",
        total,
        completed,
        dropId: record.id,
      });
    }

    onProgress?.({
      phase: "complete",
      total,
      completed,
      dropId: options.dropId,
    });

    return {
      total,
      synced: completed,
      skipped,
      targetScope: target.scope,
    };
  }
}

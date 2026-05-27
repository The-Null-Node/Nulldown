import {
  generateDropId,
  isShortDropId,
  toShortDropId,
} from "../../../../shared/drop/id";
import {
  isDropEnvelopeV1,
  type DropEnvelopeV1,
} from "../../../../shared/drop/types";
import {
  getKvItem,
  getOfflineDrop,
  isIndexedDbSupported,
  listOfflineDrops,
  putOfflineDrop,
  removeKvItem,
  removeOfflineDrop,
  setKvItem,
  type IndexedDbDropRecord,
} from "../../indexedDb";
import type {
  DropCrudRecord,
  StoredDropRecord,
  VoidStorage,
  VoidStorageCreateOptions,
} from "./types";
import { buildDropUrl } from "../provider/url";

const OFFLINE_DROP_ALIAS_PREFIX = "nulldown_drop_alias_local_";

const createDropId = () => generateDropId();

const createOfflineAliasKey = (shortId: string) =>
  `${OFFLINE_DROP_ALIAS_PREFIX}${shortId}`;

/** IndexedDB-backed sealed storage for local void provider ports. */
export class IndexedDbVoidStorage implements VoidStorage {
  readonly scope = "local" as const;

  async create(
    envelope: DropEnvelopeV1,
    options: VoidStorageCreateOptions = {},
  ): Promise<{ id: string; url: string }> {
    if (!isIndexedDbSupported()) {
      throw new Error(
        "Local storage provider requires IndexedDB support in this browser.",
      );
    }

    const maxAttempts = options.id ? 1 : 64;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const now = Date.now();
      const id = options.id ?? createDropId();
      const shortId = toShortDropId(id);

      // Short ids are cached locally so `/d/<short>` can still resolve after the page reloads.
      const aliasState = await this.reserveShortAlias(shortId, id);
      if (aliasState === "conflict") {
        if (options.id) {
          throw new Error(
            `Drop short id "${shortId}" is already in use locally.`,
          );
        }
        continue;
      }

      const existing = await getOfflineDrop(id);
      if (existing && !options.upsert) {
        if (aliasState === "reserved") {
          await this.releaseShortAlias(shortId, id);
        }

        if (options.id) {
          throw new Error(`Drop with id "${id}" already exists locally.`);
        }
        continue;
      }

      const record: IndexedDbDropRecord = {
        id,
        storageFormat: "sealed_v1",
        sealedEnvelope: envelope,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      try {
        await putOfflineDrop(record);
      } catch (error) {
        if (aliasState === "reserved") {
          await this.releaseShortAlias(shortId, id);
        }
        throw error;
      }

      return {
        id,
        url: buildDropUrl(id),
      };
    }

    throw new Error("Unable to allocate a unique local drop id.");
  }

  async get(id: string): Promise<StoredDropRecord | null> {
    if (!isIndexedDbSupported()) {
      return null;
    }

    const resolvedId = await this.resolveId(id);
    if (!resolvedId) {
      return null;
    }

    const record = await getOfflineDrop(resolvedId);
    if (!record) {
      return null;
    }

    if (record.sealedEnvelope && isDropEnvelopeV1(record.sealedEnvelope)) {
      return {
        kind: "sealed",
        id: resolvedId,
        envelope: record.sealedEnvelope,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    }

    if (typeof record.content === "string") {
      return {
        kind: "legacy",
        id: resolvedId,
        payload: {
          content: record.content,
          metadata: record.metadata,
        },
      };
    }

    return null;
  }

  async list(): Promise<DropCrudRecord[]> {
    const records = await listOfflineDrops();
    return records
      .filter(
        (
          record,
        ): record is IndexedDbDropRecord & { sealedEnvelope: DropEnvelopeV1 } =>
          Boolean(
            record.sealedEnvelope && isDropEnvelopeV1(record.sealedEnvelope),
          ),
      )
      .map((record) => ({
        id: record.id,
        envelope: record.sealedEnvelope,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }));
  }

  async delete(id: string): Promise<void> {
    if (!isIndexedDbSupported()) {
      return;
    }

    const resolvedId = await this.resolveId(id);
    if (!resolvedId) {
      return;
    }

    await removeOfflineDrop(resolvedId);
    await this.releaseShortAlias(toShortDropId(resolvedId), resolvedId);
  }

  private async resolveId(id: string): Promise<string | null> {
    if (!isShortDropId(id)) {
      return id;
    }

    return this.resolveShortId(id);
  }

  private async resolveShortId(shortId: string): Promise<string | null> {
    const aliasKey = createOfflineAliasKey(shortId);
    const aliasedId = await getKvItem(aliasKey);
    if (aliasedId) {
      const aliasedRecord = await getOfflineDrop(aliasedId);
      if (aliasedRecord) {
        return aliasedId;
      }

      await removeKvItem(aliasKey);
    }

    const records = await listOfflineDrops();
    const matches = records
      .filter((record) => record.id.startsWith(shortId))
      .sort((a, b) => b.updatedAt - a.updatedAt);

    const resolved = matches[0]?.id ?? null;
    if (resolved) {
      await setKvItem(aliasKey, resolved);
    }

    return resolved;
  }

  private async reserveShortAlias(
    shortId: string,
    id: string,
  ): Promise<"reserved" | "already-registered" | "conflict"> {
    const aliasKey = createOfflineAliasKey(shortId);
    const existing = await getKvItem(aliasKey);

    if (!existing) {
      await setKvItem(aliasKey, id);
      return "reserved";
    }

    if (existing === id) {
      return "already-registered";
    }

    const existingRecord = await getOfflineDrop(existing);
    if (!existingRecord) {
      await setKvItem(aliasKey, id);
      return "reserved";
    }

    return "conflict";
  }

  private async releaseShortAlias(shortId: string, id: string): Promise<void> {
    const aliasKey = createOfflineAliasKey(shortId);
    const existing = await getKvItem(aliasKey);
    if (existing === id) {
      await removeKvItem(aliasKey);
    }
  }
}

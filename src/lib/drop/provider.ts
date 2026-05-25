/*
Providers are the boundary between the editor's plain payload model and the actual
storage backends. Every create goes through the crypto port first, then through either
local IndexedDB or remote Pages Functions, and lineage is reconstructed from payload
metadata instead of any separate graph object.
*/

import {
  generateDropId,
  isShortDropId,
  toShortDropId,
} from "../../../shared/drop/id";
import {
  isDropEnvelopeV1,
  isDropPayload,
  type DropEnvelopeV1,
  type DropGraph,
  type DropGraphNode,
  type DropPayload,
  type DropUnlockPolicy,
  type DropVisibility,
} from "../../../shared/drop/types";
import {
  getKvItem,
  getKvValue,
  getOfflineDrop,
  isIndexedDbSupported,
  listOfflineDrops,
  putOfflineDrop,
  removeKvItem,
  removeOfflineDrop,
  setKvItem,
  setKvValue,
  type IndexedDbDropRecord,
} from "../indexedDb";
import {
  createBrowserDropCrypto,
  type DropCryptoPort,
  type DropSealOptions,
} from "./browserDropCrypto";

export type DropProviderScope = "local" | "remote";

export interface DropCreateOptions {
  id?: string;
  upsert?: boolean;
  expectedRevision?: string;
  visibility?: DropVisibility;
  unlockPolicy?: DropUnlockPolicy;
}

export interface DropSyncOptions {
  dropId?: string;
}

export interface DropSyncProgress {
  phase: "start" | "record" | "complete";
  total: number;
  completed: number;
  dropId?: string;
}

export interface DropSyncResult {
  total: number;
  synced: number;
  skipped: number;
  targetScope: DropProviderScope;
}

export interface DropCrudRecord {
  id: string;
  envelope: DropEnvelopeV1;
  createdAt: number;
  updatedAt: number;
  revision?: string | null;
}

export interface DropCrudCreateOptions {
  upsert?: boolean;
  expectedRevision?: string;
}

export interface Crud<T, TOptions> {
  // single options for now, must expand later if needed.
  create: (record: T, options?: TOptions) => Promise<void>;
  get: (id: string) => Promise<DropCrudRecord | null>;
  update: (id: string, record: Partial<DropCrudRecord>) => Promise<void>;
  delete: (id: string) => Promise<void>;
  list: () => Promise<DropCrudRecord[]>;
}

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

export interface DropCrudContext {
  drops: DropCrud;
}

type StoredDropRecord =
  | {
      kind: "sealed";
      id: string;
      envelope: DropEnvelopeV1;
      createdAt: number;
      updatedAt: number;
      revision?: string | null;
    }
  | { kind: "legacy"; id: string; payload: DropPayload };

interface DropStoragePort {
  scope: DropProviderScope;
  create: (
    envelope: DropEnvelopeV1,
    options?: { id?: string; upsert?: boolean; expectedRevision?: string },
  ) => Promise<{ id: string; url: string }>;
  get: (id: string) => Promise<StoredDropRecord | null>;
  list: () => Promise<DropCrudRecord[]>;
  delete: (id: string) => Promise<void>;
}

interface DropGraphPort {
  resolve: (
    id: string,
    getDrop: (dropId: string) => Promise<DropPayload | null>,
  ) => Promise<DropGraph>;
}

export interface DropProvider {
  /* VoidProvider, v0.0 */
  scope: DropProviderScope;
  crud: DropCrudContext;
  create: (
    payload: DropPayload,
    options?: DropCreateOptions,
  ) => Promise<{ id: string; url: string; scope: DropProviderScope }>;
  get: (id: string) => Promise<DropPayload | null>;
  resolveGraph: (id: string) => Promise<DropGraph>;
  sync: (
    target: DropProvider,
    options?: DropSyncOptions,
    onProgress?: (progress: DropSyncProgress) => void,
  ) => Promise<DropSyncResult>;
}

export interface DropProviderRegistry {
  local: DropProvider;
  remote: DropProvider;
  forDropId: (id: string) => DropProvider;
}

const OFFLINE_DROP_GRAPH_CACHE_PREFIX = "nulldown_drop_graph_cache_local_";
const REMOTE_DROP_GRAPH_CACHE_PREFIX = "nulldown_drop_graph_cache_remote_";
const OFFLINE_DROP_ALIAS_PREFIX = "nulldown_drop_alias_local_";
export const OFFLINE_DROP_PREFIX = "offline_";

interface ShareApiResponse {
  id?: string;
  url?: string;
  error?: string;
}

interface ListApiResponse {
  items?: Array<{ id: string; createdAt?: number; updatedAt?: number }>;
  error?: string;
}

interface ApiErrorResponse {
  error?: string;
  code?: string;
  details?: unknown;
}

export class DropProviderHttpError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: unknown;

  constructor(input: {
    status: number;
    message: string;
    code?: string | null;
    details?: unknown;
  }) {
    super(input.message);
    this.name = "DropProviderHttpError";
    this.status = input.status;
    this.code = input.code ?? null;
    this.details = input.details;
  }
}

export const isDropProviderHttpError = (
  value: unknown,
): value is DropProviderHttpError => value instanceof DropProviderHttpError;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseApiErrorBody = (raw: string): ApiErrorResponse | null => {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    return {
      error: typeof parsed.error === "string" ? parsed.error : undefined,
      code: typeof parsed.code === "string" ? parsed.code : undefined,
      details: parsed.details,
    };
  } catch {
    return null;
  }
};

const createHttpErrorFromResponse = async (
  response: Response,
  fallbackMessage: string,
): Promise<DropProviderHttpError> => {
  const rawBody = await response.text();
  const apiError = parseApiErrorBody(rawBody);
  const bodyMessage = apiError?.error || rawBody || response.statusText;

  return new DropProviderHttpError({
    status: response.status,
    code: apiError?.code ?? null,
    details: apiError?.details,
    message: `${response.status}: ${bodyMessage || fallbackMessage}`,
  });
};

const createDropId = () => generateDropId();

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    const prefix =
      error.name && error.name !== "Error" ? `${error.name}: ` : "";
    return `${prefix}${error.message}`.trim();
  }

  return String(error);
};

const createOfflineAliasKey = (shortId: string) =>
  `${OFFLINE_DROP_ALIAS_PREFIX}${shortId}`;

const buildDropUrl = (id: string) => {
  const linkId = toShortDropId(id);

  if (typeof window === "undefined") {
    return `/d/${linkId}`;
  }

  return `${window.location.origin}/d/${linkId}`;
};

class LocalDropStorage implements DropStoragePort {
  readonly scope = "local" as const;

  async create(
    envelope: DropEnvelopeV1,
    options: { id?: string; upsert?: boolean; expectedRevision?: string } = {},
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

class RemoteDropStorage implements DropStoragePort {
  readonly scope = "remote" as const;

  async create(
    envelope: DropEnvelopeV1,
    options: { id?: string; upsert?: boolean; expectedRevision?: string } = {},
  ): Promise<{ id: string; url: string }> {
    const response = await fetch("/api/store", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: options.id,
        upsert: options.upsert,
        expectedRevision: options.expectedRevision,
        envelope,
      }),
    });

    if (!response.ok) {
      throw await createHttpErrorFromResponse(
        response,
        "Failed to store drop.",
      );
    }

    const result = (await response.json()) as ShareApiResponse;
    if (!result.id || !result.url) {
      throw new Error(
        result.error || "Remote provider did not return drop URL.",
      );
    }

    return {
      id: result.id,
      url: result.url,
    };
  }

  async get(id: string): Promise<StoredDropRecord | null> {
    const response = await fetch(`/api/get/${encodeURIComponent(id)}`);
    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw await createHttpErrorFromResponse(
        response,
        "Failed to fetch drop.",
      );
    }

    const canonicalId = response.headers.get("X-Drop-Canonical-Id") || id;

    const contentType = response.headers.get("Content-Type") || "";
    if (contentType.includes("application/json")) {
      const payload = (await response.json()) as unknown;

      if (isDropEnvelopeV1(payload)) {
        const revisionHeader = response.headers.get("X-Drop-Revision");
        return {
          kind: "sealed",
          id: canonicalId,
          envelope: payload,
          createdAt: payload.createdAt,
          updatedAt: payload.createdAt,
          revision: revisionHeader,
        };
      }

      if (isDropPayload(payload)) {
        return {
          kind: "legacy",
          id: canonicalId,
          payload,
        };
      }

      throw new Error("Unsupported JSON drop payload format.");
    }

    const content = await response.text();
    return {
      kind: "legacy",
      id: canonicalId,
      payload: {
        content,
      },
    };
  }

  async list(): Promise<DropCrudRecord[]> {
    const response = await fetch("/api/list");

    if (!response.ok) {
      throw await createHttpErrorFromResponse(
        response,
        "Failed to list remote drops.",
      );
    }

    const payload = (await response.json()) as ListApiResponse;
    const items = payload.items ?? [];
    const hydrated = await Promise.all(
      items.map(async (item) => {
        const stored = await this.get(item.id);
        if (!stored || stored.kind !== "sealed") {
          return null;
        }

        return {
          id: stored.id,
          envelope: stored.envelope,
          createdAt: item.createdAt ?? stored.createdAt,
          updatedAt: item.updatedAt ?? stored.updatedAt,
        } satisfies DropCrudRecord;
      }),
    );

    return hydrated.filter((record): record is DropCrudRecord =>
      Boolean(record),
    );
  }

  async delete(id: string): Promise<void> {
    const response = await fetch(`/api/delete/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });

    if (!response.ok && response.status !== 404) {
      throw await createHttpErrorFromResponse(
        response,
        "Failed to delete remote drop.",
      );
    }
  }
}

class LineageDropGraphPort implements DropGraphPort {
  private readonly cachePrefix: string;

  constructor(cachePrefix: string) {
    this.cachePrefix = cachePrefix;
  }

  async resolve(
    id: string,
    getDrop: (dropId: string) => Promise<DropPayload | null>,
  ): Promise<DropGraph> {
    const cacheKey = `${this.cachePrefix}${id}`;
    const cached = await this.readCachedGraph(cacheKey);
    if (cached) {
      return cached;
    }

    const lineage: string[] = [];
    const nodes: DropGraphNode[] = [];
    const visited = new Set<string>();
    let currentId: string | null = id;

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);

      const payload = await getDrop(currentId);
      if (!payload) {
        break;
      }

      const baseDropId =
        typeof payload.metadata?.baseDropId === "string"
          ? payload.metadata.baseDropId
          : null;

      lineage.push(currentId);
      nodes.push({
        id: currentId,
        baseDropId,
      });

      currentId = baseDropId;
    }

    if (!lineage.length) {
      throw new Error(
        "Unable to build drop graph because the head drop is missing.",
      );
    }

    const graph: DropGraph = {
      headId: id,
      rootId: lineage[lineage.length - 1],
      lineage,
      nodes,
      builtAt: Date.now(),
    };

    await this.cacheGraph(cacheKey, graph);

    return graph;
  }

  private async cacheGraph(key: string, graph: DropGraph) {
    if (!isIndexedDbSupported()) {
      return;
    }

    try {
      await setKvValue(key, graph);
    } catch (error) {
      console.error(`Failed to cache drop graph "${key}":`, error);
    }
  }

  private async readCachedGraph(key: string): Promise<DropGraph | null> {
    if (!isIndexedDbSupported()) {
      return null;
    }

    try {
      return await getKvValue<DropGraph>(key);
    } catch (error) {
      console.error(`Failed to read cached drop graph "${key}":`, error);
      return null;
    }
  }
}

class ComposedDropProvider implements DropProvider {
  readonly scope: DropProviderScope;
  readonly crud: DropCrudContext;

  constructor(
    private readonly storage: DropStoragePort,
    private readonly cryptoPort: DropCryptoPort,
    private readonly graphPort: DropGraphPort,
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
    options: DropCreateOptions = {},
  ): Promise<{ id: string; url: string; scope: DropProviderScope }> {
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

  async resolveGraph(id: string): Promise<DropGraph> {
    return this.graphPort.resolve(id, (dropId) => this.get(dropId));
  }

  async sync(
    target: DropProvider,
    options: DropSyncOptions = {},
    onProgress?: (progress: DropSyncProgress) => void,
  ): Promise<DropSyncResult> {
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

class DefaultDropProviderRegistry implements DropProviderRegistry {
  constructor(
    readonly local: DropProvider,
    readonly remote: DropProvider,
  ) {}

  forDropId(id: string): DropProvider {
    return isOfflineDropId(id) ? this.local : this.remote;
  }
}

export interface CreateLocalDropProviderOptions {
  crypto?: DropCryptoPort;
}

export const createLocalDropProvider = (
  options: CreateLocalDropProviderOptions = {},
): DropProvider => {
  const crypto = options.crypto ?? createBrowserDropCrypto();

  return new ComposedDropProvider(
    new LocalDropStorage(),
    crypto,
    new LineageDropGraphPort(OFFLINE_DROP_GRAPH_CACHE_PREFIX),
  );
};

export interface CreateRemoteDropProviderOptions {
  crypto?: DropCryptoPort;
}

export const createRemoteDropProvider = (
  options: CreateRemoteDropProviderOptions = {},
): DropProvider => {
  const crypto = options.crypto ?? createBrowserDropCrypto();
  return new ComposedDropProvider(
    new RemoteDropStorage(),
    crypto,
    new LineageDropGraphPort(REMOTE_DROP_GRAPH_CACHE_PREFIX),
  );
};

export interface CreateDropProviderRegistryOptions {
  crypto?: DropCryptoPort;
}

export const createDropProviderRegistry = (
  options: CreateDropProviderRegistryOptions = {},
): DropProviderRegistry => {
  const crypto = options.crypto ?? createBrowserDropCrypto();
  const local = createLocalDropProvider({ crypto });
  const remote = createRemoteDropProvider({ crypto });
  return new DefaultDropProviderRegistry(local, remote);
};

let defaultRegistry: DropProviderRegistry | null = null;

export const getDefaultDropProviderRegistry = (): DropProviderRegistry => {
  if (!defaultRegistry) {
    defaultRegistry = createDropProviderRegistry();
  }

  return defaultRegistry;
};

export const isOfflineDropId = (id: string) =>
  id.startsWith(OFFLINE_DROP_PREFIX);

export const getProviderForDropId = (id: string): DropProvider =>
  getDefaultDropProviderRegistry().forDropId(id);

export const localDropProvider = getDefaultDropProviderRegistry().local;
export const remoteDropProvider = getDefaultDropProviderRegistry().remote;

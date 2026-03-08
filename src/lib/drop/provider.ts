import {
  isDropEnvelopeV1,
  isDropPayload,
  type DropEnvelopeV1,
  type DropGraph,
  type DropGraphNode,
  type DropPayload,
} from "../../../shared/drop/types";
import {
  getKvValue,
  getOfflineDrop,
  isIndexedDbSupported,
  putOfflineDrop,
  setKvValue,
  type IndexedDbDropRecord,
} from "../indexedDb";
import {
  createBrowserDropCrypto,
  type DropCryptoPort,
} from "./browserDropCrypto";

export type DropProviderScope = "local" | "remote";

type StoredDropRecord =
  | { kind: "sealed"; envelope: DropEnvelopeV1 }
  | { kind: "legacy"; payload: DropPayload };

interface DropStoragePort {
  scope: DropProviderScope;
  create: (envelope: DropEnvelopeV1) => Promise<{ id: string; url: string }>;
  get: (id: string) => Promise<StoredDropRecord | null>;
}

interface DropGraphPort {
  resolve: (
    id: string,
    getDrop: (dropId: string) => Promise<DropPayload | null>,
  ) => Promise<DropGraph>;
}

export interface DropProvider {
  scope: DropProviderScope;
  create: (
    payload: DropPayload,
  ) => Promise<{ id: string; url: string; scope: DropProviderScope }>;
  get: (id: string) => Promise<DropPayload | null>;
  resolveGraph: (id: string) => Promise<DropGraph>;
}

export interface DropProviderRegistry {
  local: DropProvider;
  remote: DropProvider;
  forDropId: (id: string) => DropProvider;
}

const OFFLINE_DROP_GRAPH_CACHE_PREFIX = "nulldown_drop_graph_cache_local_";
const REMOTE_DROP_GRAPH_CACHE_PREFIX = "nulldown_drop_graph_cache_remote_";
export const OFFLINE_DROP_PREFIX = "offline_";

interface ShareApiResponse {
  id?: string;
  url?: string;
  error?: string;
}

const createOfflineDropId = () => {
  const randomPart =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

  return `${OFFLINE_DROP_PREFIX}${randomPart}`;
};

const buildOfflineDropUrl = (id: string) => {
  if (typeof window === "undefined") {
    return `/d/${id}`;
  }
  return `${window.location.origin}/d/${id}`;
};

class LocalDropStorage implements DropStoragePort {
  readonly scope = "local" as const;

  async create(envelope: DropEnvelopeV1): Promise<{ id: string; url: string }> {
    if (!isIndexedDbSupported()) {
      throw new Error(
        "Local storage provider requires IndexedDB support in this browser.",
      );
    }

    const now = Date.now();
    const id = createOfflineDropId();

    const record: IndexedDbDropRecord = {
      id,
      storageFormat: "sealed_v1",
      sealedEnvelope: envelope,
      createdAt: now,
      updatedAt: now,
    };

    await putOfflineDrop(record);

    return {
      id,
      url: buildOfflineDropUrl(id),
    };
  }

  async get(id: string): Promise<StoredDropRecord | null> {
    if (!isIndexedDbSupported()) {
      return null;
    }

    const record = await getOfflineDrop(id);
    if (!record) {
      return null;
    }

    if (record.sealedEnvelope && isDropEnvelopeV1(record.sealedEnvelope)) {
      return {
        kind: "sealed",
        envelope: record.sealedEnvelope,
      };
    }

    if (typeof record.content === "string") {
      return {
        kind: "legacy",
        payload: {
          content: record.content,
          metadata: record.metadata,
        },
      };
    }

    return null;
  }
}

class RemoteDropStorage implements DropStoragePort {
  readonly scope = "remote" as const;

  async create(envelope: DropEnvelopeV1): Promise<{ id: string; url: string }> {
    const response = await fetch("/api/store", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(envelope),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        errorBody || `Failed to store drop: ${response.statusText}`,
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
    const response = await fetch(`/api/get/${id}`);
    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        errorBody || `Failed to fetch drop: ${response.statusText}`,
      );
    }

    const contentType = response.headers.get("Content-Type") || "";
    if (contentType.includes("application/json")) {
      const payload = (await response.json()) as unknown;

      if (isDropEnvelopeV1(payload)) {
        return {
          kind: "sealed",
          envelope: payload,
        };
      }

      if (isDropPayload(payload)) {
        return {
          kind: "legacy",
          payload,
        };
      }

      throw new Error("Unsupported JSON drop payload format.");
    }

    const content = await response.text();
    return {
      kind: "legacy",
      payload: {
        content,
      },
    };
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

  constructor(
    private readonly storage: DropStoragePort,
    private readonly cryptoPort: DropCryptoPort,
    private readonly graphPort: DropGraphPort,
  ) {
    this.scope = storage.scope;
  }

  async create(
    payload: DropPayload,
  ): Promise<{ id: string; url: string; scope: DropProviderScope }> {
    const envelope = await this.cryptoPort.seal(payload);
    const created = await this.storage.create(envelope);

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

    return this.cryptoPort.open(stored.envelope);
  }

  async resolveGraph(id: string): Promise<DropGraph> {
    return this.graphPort.resolve(id, (dropId) => this.get(dropId));
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

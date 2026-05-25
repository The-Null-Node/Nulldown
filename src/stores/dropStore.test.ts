import { jest } from "@jest/globals";
import type {
  DropEnvelopeV1,
  DropGraph,
  DropPayload,
} from "../../shared/drop/types";

interface LoadedDropStore {
  useDropStore: typeof import("./dropStore").default;
  localCreate: jest.MockedFunction<
    (
      payload: DropPayload,
      options?: {
        id?: string;
        upsert?: boolean;
        visibility?: "private" | "unlisted" | "public";
        unlockPolicy?: "vault-only" | "provider-escrow";
      },
    ) => Promise<{ id: string; url: string; scope: "local" }>
  >;
  localGet: jest.MockedFunction<(id: string) => Promise<DropPayload | null>>;
  remoteGet: jest.MockedFunction<(id: string) => Promise<DropPayload | null>>;
  remoteCreate: jest.MockedFunction<
    (
      payload: DropPayload,
      options?: {
        id?: string;
        upsert?: boolean;
        visibility?: "private" | "unlisted" | "public";
        unlockPolicy?: "vault-only" | "provider-escrow";
      },
    ) => Promise<{ id: string; url: string; scope: "remote" }>
  >;
  localCrudGet: jest.MockedFunction<
    (
      id: string,
    ) => Promise<{
      id: string;
      envelope: DropEnvelopeV1;
      createdAt: number;
      updatedAt: number;
      revision?: string | null;
    } | null>
  >;
  remoteCrudGet: jest.MockedFunction<
    (
      id: string,
    ) => Promise<{
      id: string;
      envelope: DropEnvelopeV1;
      createdAt: number;
      updatedAt: number;
      revision?: string | null;
    } | null>
  >;
  localCrudCreate: jest.MockedFunction<
    (
      record: {
        id: string;
        envelope: DropEnvelopeV1;
        createdAt: number;
        updatedAt: number;
        revision?: string | null;
      },
      options?: { upsert?: boolean; expectedRevision?: string },
    ) => Promise<void>
  >;
  remoteCrudCreate: jest.MockedFunction<
    (
      record: {
        id: string;
        envelope: DropEnvelopeV1;
        createdAt: number;
        updatedAt: number;
        revision?: string | null;
      },
      options?: { upsert?: boolean; expectedRevision?: string },
    ) => Promise<void>
  >;
  localResolveGraph: jest.MockedFunction<(id: string) => Promise<DropGraph>>;
  remoteResolveGraph: jest.MockedFunction<(id: string) => Promise<DropGraph>>;
}

const createGraph = (id: string): DropGraph => ({
  headId: id,
  rootId: id,
  lineage: [id],
  nodes: [{ id, baseDropId: null }],
  builtAt: Date.now(),
});

const createEnvelope = (accountId = "account-1"): DropEnvelopeV1 => ({
  schema: "nmdn.drop.v1",
  version: 1,
  createdAt: Date.now(),
  accountId,
  visibility: "unlisted",
  unlockPolicy: "provider-escrow",
  metadata: {},
  cipher: {
    alg: "A256GCM",
    iv: "iv",
    ciphertext: "cipher",
  },
  keyEnvelope: {
    mode: "account-vault-rsa-oaep",
    kid: "enc-kid",
    wrappedKey: "wrapped",
  },
  signatures: {
    device: {
      kid: "sig-kid",
      alg: "ECDSA_P256_SHA256",
      sig: "sig",
    },
  },
});

const loadDropStore = async (): Promise<LoadedDropStore> => {
  jest.resetModules();

  const localGet = jest.fn() as LoadedDropStore["localGet"];
  const remoteGet = jest.fn() as LoadedDropStore["remoteGet"];
  const localCreate = jest.fn() as LoadedDropStore["localCreate"];
  const localSync = jest.fn(async () => ({
    total: 1,
    synced: 1,
    skipped: 0,
    targetScope: "remote" as const,
  }));
  const remoteCreate = jest.fn() as LoadedDropStore["remoteCreate"];
  const localCrudGet = jest.fn() as LoadedDropStore["localCrudGet"];
  const remoteCrudGet = jest.fn() as LoadedDropStore["remoteCrudGet"];
  const localCrudCreate = jest.fn(async () => undefined) as LoadedDropStore["localCrudCreate"];
  const remoteCrudCreate = jest.fn(async () => undefined) as LoadedDropStore["remoteCrudCreate"];
  const localResolveGraph = jest.fn() as LoadedDropStore["localResolveGraph"];
  const remoteResolveGraph = jest.fn() as LoadedDropStore["remoteResolveGraph"];
  const kvStore = new Map<string, unknown>();

  localCreate.mockResolvedValue({
    id: "local_id_1234",
    url: "https://example.com/d/local",
    scope: "local",
  });
  localGet.mockResolvedValue(null);
  remoteGet.mockResolvedValue(null);
  remoteCreate.mockResolvedValue({
    id: "remote_id_1234",
    url: "https://example.com/d/remote",
    scope: "remote",
  });
  localCrudGet.mockResolvedValue(null);
  remoteCrudGet.mockResolvedValue(null);

  const localProvider = {
    scope: "local",
    get: localGet,
    resolveGraph: localResolveGraph,
      create: localCreate,
      sync: localSync,
      crud: {
        drops: {
          create: localCrudCreate,
          get: localCrudGet,
          update: jest.fn(),
          delete: jest.fn(),
        list: jest.fn(async () => []),
      },
    },
  };

  const remoteProvider = {
    scope: "remote",
    get: remoteGet,
    resolveGraph: remoteResolveGraph,
      create: remoteCreate,
      sync: jest.fn(),
      crud: {
        drops: {
          create: remoteCrudCreate,
          get: remoteCrudGet,
          update: jest.fn(),
          delete: jest.fn(),
        list: jest.fn(async () => []),
      },
    },
  };

  jest.unstable_mockModule("../lib/indexedDb", () => ({
    getKvItem: jest.fn(async (key: string) => {
      const value = kvStore.get(key);
      return value === undefined || value === null ? null : String(value);
    }),
    getKvValue: jest.fn(async (key: string) => {
      const value = kvStore.get(key);
      return value === undefined ? null : value;
    }),
    isIndexedDbSupported: jest.fn().mockReturnValue(false),
    setKvItem: jest.fn(async (key: string, value: string) => {
      kvStore.set(key, value);
    }),
    setKvValue: jest.fn(async (key: string, value: unknown) => {
      kvStore.set(key, value);
    }),
  }));

  jest.unstable_mockModule("../lib/drop/passkeyVault", () => ({
    PASSKEY_PROTECTION_STORAGE_KEY: "nulldown_passkey_protection",
    getUnlockedVault: jest.fn(async () => ({
      accountId: "account-1",
    })),
  }));

  jest.unstable_mockModule("../lib/drop/provider", () => ({
    getDefaultDropProviderRegistry: () => ({
      local: localProvider,
      remote: remoteProvider,
      forDropId: (id: string) =>
        id.startsWith("offline_") ? localProvider : remoteProvider,
    }),
    isDropProviderHttpError: (value: unknown) =>
      typeof value === "object" && value !== null && "status" in value,
    isOfflineDropId: (id: string) => id.startsWith("offline_"),
    OFFLINE_DROP_PREFIX: "offline_",
  }));

  const module = await import("./dropStore");

  return {
    useDropStore: module.default,
    localCreate,
    localGet,
    remoteGet,
    remoteCreate,
    localCrudGet,
    remoteCrudGet,
    localCrudCreate,
    remoteCrudCreate,
    localResolveGraph,
    remoteResolveGraph,
  };
};

describe("dropStore resolution", () => {
  let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;
  let consoleWarnSpy: jest.SpiedFunction<typeof console.warn>;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it("resolves drops from local first", async () => {
    const { useDropStore, localGet, remoteGet } = await loadDropStore();
    const payload: DropPayload = { content: "local payload" };
    localGet.mockResolvedValue(payload);

    const result = await useDropStore.getState().getDrop("abc123");

    expect(result).toEqual(payload);
    expect(localGet).toHaveBeenCalledWith("abc123");
    expect(remoteGet).not.toHaveBeenCalled();
  });

  it("falls back to remote when local misses", async () => {
    const { useDropStore, localGet, remoteGet } = await loadDropStore();
    const payload: DropPayload = { content: "remote payload" };
    localGet.mockResolvedValue(null);
    remoteGet.mockResolvedValue(payload);

    const result = await useDropStore.getState().getDrop("abc123");

    expect(result).toEqual(payload);
    expect(localGet).toHaveBeenCalledWith("abc123");
    expect(remoteGet).toHaveBeenCalledWith("abc123");
  });

  it("falls back to remote when local throws", async () => {
    const { useDropStore, localGet, remoteGet } = await loadDropStore();
    const payload: DropPayload = { content: "remote payload" };
    localGet.mockRejectedValue(new Error("local failed"));
    remoteGet.mockResolvedValue(payload);

    const result = await useDropStore.getState().getDrop("abc123");

    expect(result).toEqual(payload);
    expect(remoteGet).toHaveBeenCalledWith("abc123");
  });

  it("returns null when neither provider resolves", async () => {
    const { useDropStore, localGet, remoteGet } = await loadDropStore();
    localGet.mockResolvedValue(null);
    remoteGet.mockResolvedValue(null);

    const result = await useDropStore.getState().getDrop("abc123");

    expect(result).toBeNull();
  });

  it("throws a resolution error when at least one provider fails", async () => {
    const { useDropStore, localGet, remoteGet } = await loadDropStore();
    localGet.mockResolvedValue(null);
    remoteGet.mockRejectedValue(new Error("remote failed"));

    await expect(useDropStore.getState().getDrop("abc123")).rejects.toThrow(
      'Failed to resolve drop "abc123"',
    );
    await expect(useDropStore.getState().getDrop("abc123")).rejects.toThrow(
      "remote failed",
    );
  });

  it("resolves drop graphs from local first", async () => {
    const { useDropStore, localResolveGraph, remoteResolveGraph } =
      await loadDropStore();
    const graph = createGraph("abc123");
    localResolveGraph.mockResolvedValue(graph);

    const result = await useDropStore.getState().resolveDropGraph("abc123");

    expect(result).toEqual(graph);
    expect(remoteResolveGraph).not.toHaveBeenCalled();
  });

  it("falls back to remote graph resolution when local fails", async () => {
    const { useDropStore, localResolveGraph, remoteResolveGraph } =
      await loadDropStore();
    const graph = createGraph("abc123");
    localResolveGraph.mockRejectedValue(new Error("local graph failed"));
    remoteResolveGraph.mockResolvedValue(graph);

    const result = await useDropStore.getState().resolveDropGraph("abc123");

    expect(result).toEqual(graph);
    expect(remoteResolveGraph).toHaveBeenCalledWith("abc123");
  });

  it("throws when both graph providers fail", async () => {
    const { useDropStore, localResolveGraph, remoteResolveGraph } =
      await loadDropStore();
    localResolveGraph.mockRejectedValue(new Error("local graph failed"));
    remoteResolveGraph.mockRejectedValue(new Error("remote graph failed"));

    await expect(
      useDropStore.getState().resolveDropGraph("abc123"),
    ).rejects.toThrow('Failed to resolve drop graph "abc123"');
  });

  it("maps mode and visibility to derived provider rules", async () => {
    const { useDropStore } = await loadDropStore();

    await useDropStore.getState().applySettings({
      mode: "online",
      shareVisibility: "private",
    });

    expect(useDropStore.getState().offlineMode).toBe(false);
    expect(useDropStore.getState().syncTargetProvider).toBe("remote");
    expect(useDropStore.getState().unlockPolicy).toBe("vault-only");

    await useDropStore.getState().applySettings({ shareVisibility: "public" });

    expect(useDropStore.getState().unlockPolicy).toBe("provider-escrow");

    await useDropStore.getState().setMode("offline");

    expect(useDropStore.getState().offlineMode).toBe(true);
    expect(useDropStore.getState().syncTargetProvider).toBe("local");
    expect(useDropStore.getState().unlockPolicy).toBe("vault-only");
  });

  it("defaults passkey protection to disabled when unset", async () => {
    const { useDropStore } = await loadDropStore();

    expect(useDropStore.getState().passkeyProtectionEnabled).toBe(false);

    await useDropStore.getState().hydrateSharePreferences();

    expect(useDropStore.getState().passkeyProtectionEnabled).toBe(false);
  });

  it("detects when the current account owns a drop", async () => {
    const { useDropStore, localCrudGet, remoteCrudGet } = await loadDropStore();

    localCrudGet.mockResolvedValue({
      id: "owned_drop_123456",
      envelope: createEnvelope("account-1"),
      createdAt: 1,
      updatedAt: 2,
    });

    const result = await useDropStore
      .getState()
      .resolveDropOwnership("owned_drop_123456");

    expect(result).toEqual({
      id: "owned_drop_123456",
      ownedByCurrentAccount: true,
    });
    expect(remoteCrudGet).not.toHaveBeenCalled();
  });

  it("detects ownership from promoted remote payload metadata", async () => {
    const { useDropStore, localCrudGet, remoteCrudGet } = await loadDropStore();
    const originalFetch = global.fetch;

    localCrudGet.mockResolvedValue(null);
    remoteCrudGet.mockResolvedValue(null);
    global.fetch = jest.fn(async () =>
      new Response(
        JSON.stringify({
          content: "promoted branch content",
          metadata: { ownerAccountId: "account-1" },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Drop-Canonical-Id": "promoted_drop_123456",
          },
        },
      ),
    ) as typeof fetch;

    try {
      const result = await useDropStore
        .getState()
        .resolveDropOwnership("promoted_drop_123456");

      expect(result).toEqual({
        id: "promoted_drop_123456",
        ownedByCurrentAccount: true,
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("passes upsert options when overwriting an existing drop", async () => {
    const { useDropStore, localCreate } = await loadDropStore();
    const payload: DropPayload = {
      content: "updated draft",
      metadata: { themeId: "system" },
    };

    await useDropStore.getState().setMode("offline");
    await useDropStore.getState().createDrop(payload, {
      id: "owned_drop_123456",
      upsert: true,
    });

    expect(localCreate).toHaveBeenCalledWith(payload, {
      id: "owned_drop_123456",
      upsert: true,
      visibility: "private",
      unlockPolicy: "vault-only",
    });
  });

  it("publishes local drop when switching offline to online", async () => {
    const {
      useDropStore,
      localGet,
      localCrudGet,
      remoteCrudGet,
      remoteCreate,
    } = await loadDropStore();

    const payload: DropPayload = {
      content: "offline draft",
      metadata: { themeId: "system" },
    };
    const localRecordId = "local_drop_123456";

    localCrudGet.mockResolvedValue({
      id: localRecordId,
      envelope: createEnvelope(),
      createdAt: 1,
      updatedAt: 2,
    });
    remoteCrudGet.mockResolvedValue(null);
    localGet.mockResolvedValue(payload);
    remoteCreate.mockResolvedValue({
      id: "remote_drop_abcdef",
      url: "https://nulldown.test/d/remot",
      scope: "remote",
    });

    await useDropStore.getState().setMode("offline");
    const transition = await useDropStore
      .getState()
      .setMode("online", { activeDropId: localRecordId });

    expect(transition.mode).toBe("online");
    expect(transition.publishedDrop).toEqual({
      sourceId: localRecordId,
      id: "remote_drop_abcdef",
      url: "https://nulldown.test/d/remot",
    });
    expect(remoteCreate).toHaveBeenCalledWith(payload, {
      id: localRecordId,
      visibility: "unlisted",
      unlockPolicy: "provider-escrow",
    });
  });

  it("queues a pending sync conflict when remote diverges", async () => {
    const { useDropStore, localCrudGet, remoteCrudGet } = await loadDropStore();
    const localRecordId = "local_drop_conflict";

    localCrudGet.mockResolvedValue({
      id: localRecordId,
      envelope: createEnvelope("account-1"),
      createdAt: 10,
      updatedAt: 20,
    });
    remoteCrudGet.mockResolvedValue({
      id: localRecordId,
      envelope: createEnvelope("account-2"),
      createdAt: 10,
      updatedAt: 25,
      revision: "remote-rev-1",
    });

    await useDropStore.getState().setMode("offline");

    await expect(
      useDropStore
        .getState()
        .setMode("online", { activeDropId: localRecordId }),
    ).rejects.toThrow("Resolve it before publishing again");

    const conflicts = useDropStore.getState().listSyncConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      dropId: localRecordId,
      status: "pending",
      reason: "remote_state_mismatch",
    });
  });

  it("resolves conflicts by accepting local state", async () => {
    const { useDropStore, localCrudGet, remoteCrudGet, remoteCrudCreate } =
      await loadDropStore();
    const localRecordId = "local_drop_resolve";

    localCrudGet.mockResolvedValue({
      id: localRecordId,
      envelope: createEnvelope("account-1"),
      createdAt: 10,
      updatedAt: 20,
    });
    remoteCrudGet.mockResolvedValue({
      id: localRecordId,
      envelope: createEnvelope("account-2"),
      createdAt: 10,
      updatedAt: 25,
      revision: "remote-rev-1",
    });

    await useDropStore.getState().setMode("offline");
    await expect(
      useDropStore
        .getState()
        .setMode("online", { activeDropId: localRecordId }),
    ).rejects.toThrow();

    const conflict = useDropStore.getState().listSyncConflicts()[0];
    await useDropStore
      .getState()
      .resolveSyncConflict(conflict.id, "accept-local");

    expect(remoteCrudCreate).toHaveBeenCalledWith(
      expect.objectContaining({ id: localRecordId }),
      { upsert: true, expectedRevision: "remote-rev-1" },
    );
    expect(useDropStore.getState().listSyncConflicts()[0]).toMatchObject({
      id: conflict.id,
      status: "resolved",
      resolution: "accept-local",
    });
  });

  it("coalesces duplicate publish intents for the same drop", async () => {
    const { useDropStore, localCrudGet, localGet, remoteCrudGet, remoteCreate } =
      await loadDropStore();
    const localRecordId = "local_drop_dupe_queue";
    const payload: DropPayload = {
      content: "offline draft",
      metadata: { themeId: "system" },
    };

    localCrudGet.mockResolvedValue({
      id: localRecordId,
      envelope: createEnvelope("account-1"),
      createdAt: 10,
      updatedAt: 20,
    });
    localGet.mockResolvedValue(payload);
    remoteCrudGet.mockResolvedValue(null);
    remoteCreate.mockResolvedValue({
      id: localRecordId,
      url: "https://nulldown.test/d/dupeqq",
      scope: "remote",
    });

    await Promise.all([
      useDropStore.getState().syncDropToRemote(localRecordId),
      useDropStore.getState().syncDropToRemote(localRecordId),
    ]);

    expect(remoteCreate).toHaveBeenCalledTimes(1);
    expect(useDropStore.getState().syncQueueDepth).toBe(0);
  });

  it("resolves conflicts by accepting remote state", async () => {
    const { useDropStore, localCrudGet, remoteCrudGet, localCrudCreate } =
      await loadDropStore();
    const localRecordId = "local_drop_accept_remote";

    localCrudGet.mockResolvedValue({
      id: localRecordId,
      envelope: createEnvelope("account-1"),
      createdAt: 10,
      updatedAt: 20,
    });
    remoteCrudGet.mockResolvedValue({
      id: localRecordId,
      envelope: createEnvelope("account-2"),
      createdAt: 10,
      updatedAt: 25,
    });

    await useDropStore.getState().setMode("offline");
    await expect(
      useDropStore
        .getState()
        .setMode("online", { activeDropId: localRecordId }),
    ).rejects.toThrow();

    const conflict = useDropStore.getState().listSyncConflicts()[0];
    await useDropStore
      .getState()
      .resolveSyncConflict(conflict.id, "accept-remote");

    expect(localCrudCreate).toHaveBeenCalledWith(
      expect.objectContaining({ id: localRecordId }),
      { upsert: true },
    );
    expect(useDropStore.getState().listSyncConflicts()[0]).toMatchObject({
      id: conflict.id,
      status: "resolved",
      resolution: "accept-remote",
    });
  });
});

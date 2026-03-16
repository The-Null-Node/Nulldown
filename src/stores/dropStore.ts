import { create } from "zustand";
import {
  getKvItem,
  isIndexedDbSupported,
  setKvItem,
} from "../lib/indexedDb";
import {
  getDefaultDropProviderRegistry,
  isOfflineDropId,
  OFFLINE_DROP_PREFIX,
  type DropCreateOptions,
  type DropProviderScope,
  type DropSyncProgress,
} from "../lib/drop/provider";
import { isShortDropId } from "../../shared/drop/id";
import type {
  DropDraftDiffPolicy,
  DropGraph,
  DropMetadata,
  DropPayload,
  DropUnlockPolicy,
  DropVisibility,
} from "../../shared/drop/types";
import {
  DEFAULT_IFRAME_ALLOWLIST,
  normalizeIframeAllowlist,
  parseIframeAllowlistInput,
} from "../lib/iframeAllowlist";

const OFFLINE_MODE_KEY = "nulldown_offline_mode";
const SHARE_VISIBILITY_KEY = "nulldown_share_visibility";
const UNLOCK_POLICY_KEY = "nulldown_unlock_policy";
const SYNC_TARGET_PROVIDER_KEY = "nulldown_sync_target_provider";
const DRAFT_DIFF_POLICY_KEY = "nulldown_draft_diff_policy";
const ALLOWED_URLS_KEY = "nulldown_allowed_urls";
const SYNTAX_MODE_KEY = "nulldown_syntax_mode";
const LEGACY_IFRAME_ALLOWLIST_KEY = "nulldown_iframe_allowlist";

const dropProviderRegistry = getDefaultDropProviderRegistry();

interface DropStoreState {
  offlineMode: boolean;
  syncTargetProvider: DropProviderScope;
  shareVisibility: DropVisibility;
  unlockPolicy: DropUnlockPolicy;
  draftDiffPolicy: DropDraftDiffPolicy;
  syntaxMode: EditorSyntaxMode;
  allowedUrls: string[];
  hydrated: boolean;
  hydrateOfflineMode: () => Promise<void>;
  hydrateSharePreferences: () => Promise<void>;
  setOfflineMode: (enabled: boolean) => Promise<void>;
  setSyncTargetProvider: (scope: DropProviderScope) => Promise<void>;
  setShareVisibility: (visibility: DropVisibility) => Promise<void>;
  setUnlockPolicy: (policy: DropUnlockPolicy) => Promise<void>;
  setDraftDiffPolicy: (policy: DropDraftDiffPolicy) => Promise<void>;
  setSyntaxMode: (mode: EditorSyntaxMode) => Promise<void>;
  setAllowedUrls: (urls: readonly string[]) => Promise<void>;
  createDrop: (
    payload: DropPayload,
    options?: Partial<DropCreateOptions>,
  ) => Promise<{ id: string; url: string; scope: DropProviderScope }>;
  syncDropToRemote: (
    id: string,
    onProgress?: (progress: DropSyncProgress) => void,
  ) => Promise<void>;
  getDrop: (id: string) => Promise<DropPayload | null>;
  resolveDropGraph: (id: string) => Promise<DropGraph>;
  listOwnedDrops: () => Promise<OwnedDropRecord[]>;
  createOfflineDrop: (
    payload: DropPayload,
  ) => Promise<{ id: string; url: string }>;
  getOfflineDrop: (id: string) => Promise<DropPayload | null>;
}

export interface OwnedDropRecord {
  id: string;
  visibility: DropVisibility;
  createdAt: number;
  updatedAt: number;
}

export type EditorSyntaxMode = "rendered" | "source";

const serializeBoolean = (enabled: boolean) => (enabled ? "1" : "0");

const parseOfflineMode = (value: string | null) =>
  value === "1" || value === "true";

const parseShareVisibility = (value: string | null): DropVisibility =>
  value === "public" ? "public" : "unlisted";

const parseUnlockPolicy = (value: string | null): DropUnlockPolicy =>
  value === "provider-escrow" ? "provider-escrow" : "vault-only";

const parseDraftDiffPolicy = (value: string | null): DropDraftDiffPolicy =>
  value === "always" ? "always" : "edited-only";

const parseSyntaxMode = (value: string | null): EditorSyntaxMode =>
  value === "source" ? "source" : "rendered";

const parseAllowedUrls = (value: string | null): string[] => {
  if (!value) {
    return [...DEFAULT_IFRAME_ALLOWLIST];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return normalizeIframeAllowlist(
        parsed.filter((entry): entry is string => typeof entry === "string"),
      );
    }
  } catch {
    return parseIframeAllowlistInput(value);
  }

  return parseIframeAllowlistInput(value);
};

const serializeAllowedUrls = (urls: readonly string[]): string =>
  JSON.stringify(normalizeIframeAllowlist(urls));

const parseSyncTargetProvider = (value: string | null): DropProviderScope =>
  value === "local" ? "local" : "remote";

const readLocalStorageItem = (key: string): string | null => {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeLocalStorageItem = (key: string, value: string) => {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore fallback failure
  }
};

const readPersistedItem = async (key: string): Promise<string | null> => {
  if (isIndexedDbSupported()) {
    try {
      const value = await getKvItem(key);
      if (value !== null) {
        return value;
      }
    } catch (error) {
      console.error(`Failed reading "${key}" from IndexedDB:`, error);
    }
  }

  return readLocalStorageItem(key);
};

const writePersistedItem = async (key: string, value: string) => {
  if (isIndexedDbSupported()) {
    try {
      await setKvItem(key, value);
      return;
    } catch (error) {
      console.error(`Failed writing "${key}" to IndexedDB:`, error);
    }
  }

  writeLocalStorageItem(key, value);
};

const useDropStore = create<DropStoreState>((set, get) => ({
  offlineMode: false,
  syncTargetProvider: "remote",
  shareVisibility: "unlisted",
  unlockPolicy: "vault-only",
  draftDiffPolicy: "edited-only",
  syntaxMode: "rendered",
  allowedUrls: [...DEFAULT_IFRAME_ALLOWLIST],
  hydrated: false,

  hydrateOfflineMode: async () => {
    if (get().hydrated) return;

    const stored = await readPersistedItem(OFFLINE_MODE_KEY);
    const offlineMode = parseOfflineMode(stored);

    await writePersistedItem(OFFLINE_MODE_KEY, serializeBoolean(offlineMode));
    set({ offlineMode, hydrated: true });
  },

  hydrateSharePreferences: async () => {
    const [
      storedVisibility,
      storedUnlockPolicy,
      storedSyncTarget,
      storedDraftDiffPolicy,
      storedSyntaxMode,
      storedAllowedUrls,
    ] = await Promise.all([
      readPersistedItem(SHARE_VISIBILITY_KEY),
      readPersistedItem(UNLOCK_POLICY_KEY),
      readPersistedItem(SYNC_TARGET_PROVIDER_KEY),
      readPersistedItem(DRAFT_DIFF_POLICY_KEY),
      readPersistedItem(SYNTAX_MODE_KEY),
      readPersistedItem(ALLOWED_URLS_KEY),
    ]);

    const shareVisibility = parseShareVisibility(storedVisibility);
    const unlockPolicy = parseUnlockPolicy(storedUnlockPolicy);
    const syncTargetProvider = parseSyncTargetProvider(storedSyncTarget);
    const draftDiffPolicy = parseDraftDiffPolicy(storedDraftDiffPolicy);
    const syntaxMode = parseSyntaxMode(storedSyntaxMode);
    const allowedUrls = parseAllowedUrls(
      storedAllowedUrls ?? (await readPersistedItem(LEGACY_IFRAME_ALLOWLIST_KEY)),
    );

    await Promise.all([
      writePersistedItem(SHARE_VISIBILITY_KEY, shareVisibility),
      writePersistedItem(UNLOCK_POLICY_KEY, unlockPolicy),
      writePersistedItem(SYNC_TARGET_PROVIDER_KEY, syncTargetProvider),
      writePersistedItem(DRAFT_DIFF_POLICY_KEY, draftDiffPolicy),
      writePersistedItem(SYNTAX_MODE_KEY, syntaxMode),
      writePersistedItem(ALLOWED_URLS_KEY, serializeAllowedUrls(allowedUrls)),
    ]);

    set({
      shareVisibility,
      unlockPolicy,
      syncTargetProvider,
      draftDiffPolicy,
      syntaxMode,
      allowedUrls,
    });
  },

  setOfflineMode: async (enabled: boolean) => {
    set({ offlineMode: enabled, hydrated: true });
    await writePersistedItem(OFFLINE_MODE_KEY, serializeBoolean(enabled));
  },

  setSyncTargetProvider: async (scope: DropProviderScope) => {
    set({ syncTargetProvider: scope });
    await writePersistedItem(SYNC_TARGET_PROVIDER_KEY, scope);
  },

  setShareVisibility: async (visibility: DropVisibility) => {
    set({ shareVisibility: visibility });
    await writePersistedItem(SHARE_VISIBILITY_KEY, visibility);
  },

  setUnlockPolicy: async (policy: DropUnlockPolicy) => {
    set({ unlockPolicy: policy });
    await writePersistedItem(UNLOCK_POLICY_KEY, policy);
  },

  setDraftDiffPolicy: async (policy: DropDraftDiffPolicy) => {
    set({ draftDiffPolicy: policy });
    await writePersistedItem(DRAFT_DIFF_POLICY_KEY, policy);
  },

  setSyntaxMode: async (mode: EditorSyntaxMode) => {
    set({ syntaxMode: mode });
    await writePersistedItem(SYNTAX_MODE_KEY, mode);
  },

  setAllowedUrls: async (urls: readonly string[]) => {
    const normalized = normalizeIframeAllowlist(urls);
    set({ allowedUrls: normalized });
    await writePersistedItem(ALLOWED_URLS_KEY, serializeAllowedUrls(normalized));
  },

  createDrop: async (payload: DropPayload, options: Partial<DropCreateOptions> = {}) => {
    await Promise.all([
      get().hydrateOfflineMode(),
      get().hydrateSharePreferences(),
    ]);

    const offlineMode = get().offlineMode;
    const visibility = offlineMode
      ? "unlisted"
      : options.visibility ?? get().shareVisibility;
    const unlockPolicy = offlineMode
      ? "vault-only"
      : options.unlockPolicy ?? get().unlockPolicy;

    const localCreated = await dropProviderRegistry.local.create(payload, {
      visibility,
      unlockPolicy,
      id: options.id,
    });

    if (offlineMode) {
      return localCreated;
    }

    const targetProvider =
      get().syncTargetProvider === "local"
        ? dropProviderRegistry.local
        : dropProviderRegistry.remote;

    if (targetProvider.scope === "local") {
      return localCreated;
    }

    const syncResult = await dropProviderRegistry.local.sync(
      targetProvider,
      { dropId: localCreated.id },
    );

    if (syncResult.synced < 1) {
      throw new Error("Failed to publish this drop to the remote provider.");
    }

    return {
      id: localCreated.id,
      url: localCreated.url,
      scope: "remote",
    };
  },

  syncDropToRemote: async (
    id: string,
    onProgress?: (progress: DropSyncProgress) => void,
  ) => {
    await dropProviderRegistry.local.sync(
      dropProviderRegistry.remote,
      { dropId: id },
      onProgress,
    );
  },

  getDrop: async (id: string) => {
    if (isShortDropId(id)) {
      try {
        const remote = await dropProviderRegistry.remote.get(id);
        if (remote) {
          return remote;
        }
      } catch {
        // fall back to local provider
      }

      return dropProviderRegistry.local.get(id);
    }

    const local = await dropProviderRegistry.local.get(id);
    if (local) {
      return local;
    }

    return dropProviderRegistry.remote.get(id);
  },

  resolveDropGraph: async (id: string) => {
    if (isShortDropId(id)) {
      try {
        return await dropProviderRegistry.remote.resolveGraph(id);
      } catch {
        return dropProviderRegistry.local.resolveGraph(id);
      }
    }

    try {
      return await dropProviderRegistry.local.resolveGraph(id);
    } catch {
      return dropProviderRegistry.remote.resolveGraph(id);
    }
  },

  listOwnedDrops: async () => {
    let records: Awaited<
      ReturnType<typeof dropProviderRegistry.local.crud.drops.list>
    >;

    try {
      records = await dropProviderRegistry.local.crud.drops.list();
    } catch (error) {
      console.error("Failed to list locally-owned drops:", error);
      return [];
    }

    return records
      .map((record) => ({
        id: record.id,
        visibility: record.envelope.visibility ?? "unlisted",
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  },

  createOfflineDrop: async (payload: DropPayload) => {
    const result = await dropProviderRegistry.local.create(payload);
    return {
      id: result.id,
      url: result.url,
    };
  },

  getOfflineDrop: async (id: string) => {
    return dropProviderRegistry.local.get(id);
  },
}));

export type { DropGraph, DropMetadata, DropPayload };
export { isOfflineDropId, OFFLINE_DROP_PREFIX };

export default useDropStore;

import { create } from "zustand";
import { toShortDropId } from "../../shared/drop/id";
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
import {
  getUnlockedVault,
  PASSKEY_PROTECTION_STORAGE_KEY,
} from "../lib/drop/passkeyVault";
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

export interface OwnedDropRecord {
  id: string;
  visibility: DropVisibility;
  createdAt: number;
  updatedAt: number;
}

export type EditorSyntaxMode = "rendered" | "source";
export type DropMode = "offline" | "online";

export interface DropSettingsState {
  mode: {
    value: DropMode;
  };
  sharing: {
    visibility: DropVisibility;
    draftDiffPolicy: DropDraftDiffPolicy;
  };
  security: {
    passkeyProtectionEnabled: boolean;
  };
  editor: {
    syntaxMode: EditorSyntaxMode;
  };
  embeds: {
    allowedUrls: string[];
  };
}

export interface ModeTransitionOptions {
  activeDropId?: string | null;
  onProgress?: (progress: DropSyncProgress) => void;
}

export interface ModeTransitionResult {
  mode: DropMode;
  publishedDrop?: {
    sourceId: string;
    id: string;
    url: string;
  };
}

interface DropSettingsChanges {
  mode?: DropMode;
  shareVisibility?: DropVisibility;
  draftDiffPolicy?: DropDraftDiffPolicy;
  passkeyProtectionEnabled?: boolean;
  syntaxMode?: EditorSyntaxMode;
  allowedUrls?: readonly string[];
}

interface DropStoreState {
  mode: DropMode;
  settings: DropSettingsState;
  offlineMode: boolean;
  syncTargetProvider: DropProviderScope;
  shareVisibility: DropVisibility;
  unlockPolicy: DropUnlockPolicy;
  draftDiffPolicy: DropDraftDiffPolicy;
  passkeyProtectionEnabled: boolean;
  syntaxMode: EditorSyntaxMode;
  allowedUrls: string[];
  hydrated: boolean;
  hydrateOfflineMode: () => Promise<void>;
  hydrateSharePreferences: () => Promise<void>;
  applySettings: (changes: DropSettingsChanges) => Promise<void>;
  setMode: (
    mode: DropMode,
    options?: ModeTransitionOptions,
  ) => Promise<ModeTransitionResult>;
  setOfflineMode: (
    enabled: boolean,
    options?: ModeTransitionOptions,
  ) => Promise<ModeTransitionResult>;
  setSyncTargetProvider: (scope: DropProviderScope) => Promise<void>;
  setShareVisibility: (visibility: DropVisibility) => Promise<void>;
  setUnlockPolicy: (policy: DropUnlockPolicy) => Promise<void>;
  setDraftDiffPolicy: (policy: DropDraftDiffPolicy) => Promise<void>;
  setPasskeyProtectionEnabled: (enabled: boolean) => Promise<void>;
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
  resolveDropOwnership: (
    id: string,
  ) => Promise<{ id: string; ownedByCurrentAccount: boolean } | null>;
  resolveDropGraph: (id: string) => Promise<DropGraph>;
  listOwnedDrops: () => Promise<OwnedDropRecord[]>;
  createOfflineDrop: (
    payload: DropPayload,
  ) => Promise<{ id: string; url: string }>;
  getOfflineDrop: (id: string) => Promise<DropPayload | null>;
}

interface DropSettingsSnapshot {
  mode: DropMode;
  shareVisibility: DropVisibility;
  draftDiffPolicy: DropDraftDiffPolicy;
  passkeyProtectionEnabled: boolean;
  syntaxMode: EditorSyntaxMode;
  allowedUrls: string[];
}

type SettingName = keyof DropSettingsSnapshot;

interface SettingDescriptor<K extends SettingName> {
  storageKey: string;
  apply: (snapshot: DropSettingsSnapshot, value: DropSettingsSnapshot[K]) => void;
  serialize: (value: DropSettingsSnapshot[K]) => string;
}

const normalizeShareVisibility = (value: string): DropVisibility => {
  if (value === "private" || value === "public" || value === "unlisted") {
    return value;
  }

  return "unlisted";
};

const normalizeDraftDiffPolicy = (value: string): DropDraftDiffPolicy =>
  value === "always" ? "always" : "edited-only";

const normalizeSyntaxMode = (value: string): EditorSyntaxMode =>
  value === "source" ? "source" : "rendered";

const parseLegacyUnlockPolicy = (value: string | null): DropUnlockPolicy =>
  value === "provider-escrow" ? "provider-escrow" : "vault-only";

const parseSyncTargetProvider = (value: string | null): DropProviderScope =>
  value === "local" ? "local" : "remote";

const parseModeFromStoredValue = (
  modeValue: string | null,
  legacySyncTarget: string | null,
): DropMode => {
  if (modeValue === "online" || modeValue === "offline") {
    return modeValue;
  }

  if (modeValue === "1" || modeValue === "true") {
    return "offline";
  }

  if (legacySyncTarget && parseSyncTargetProvider(legacySyncTarget) === "local") {
    return "offline";
  }

  return "online";
};

const parseShareVisibility = (value: string | null): DropVisibility =>
  normalizeShareVisibility(value ?? "unlisted");

const parseDraftDiffPolicy = (value: string | null): DropDraftDiffPolicy =>
  normalizeDraftDiffPolicy(value ?? "edited-only");

const parseSyntaxMode = (value: string | null): EditorSyntaxMode =>
  normalizeSyntaxMode(value ?? "rendered");

const parsePasskeyProtectionEnabled = (value: string | null): boolean =>
  value === null ? true : value === "1" || value === "true";

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

const serializeMode = (mode: DropMode) => mode;

const serializeBoolean = (enabled: boolean) => (enabled ? "1" : "0");

const serializeAllowedUrls = (urls: readonly string[]): string =>
  JSON.stringify(normalizeIframeAllowlist(urls));

const deriveSyncTargetProvider = (mode: DropMode): DropProviderScope =>
  mode === "offline" ? "local" : "remote";

const deriveUnlockPolicy = (
  mode: DropMode,
  visibility: DropVisibility,
): DropUnlockPolicy => {
  if (mode === "online" && visibility !== "private") {
    return "provider-escrow";
  }

  return "vault-only";
};

const resolveCreateVisibility = (
  mode: DropMode,
  visibility: DropVisibility,
): DropVisibility => {
  if (mode === "offline") {
    return "private";
  }

  return visibility;
};

const createSettingsObject = (
  snapshot: DropSettingsSnapshot,
): DropSettingsState => ({
  mode: {
    value: snapshot.mode,
  },
  sharing: {
    visibility: snapshot.shareVisibility,
    draftDiffPolicy: snapshot.draftDiffPolicy,
  },
  security: {
    passkeyProtectionEnabled: snapshot.passkeyProtectionEnabled,
  },
  editor: {
    syntaxMode: snapshot.syntaxMode,
  },
  embeds: {
    allowedUrls: [...snapshot.allowedUrls],
  },
});

const normalizeSettingsSnapshot = (
  snapshot: DropSettingsSnapshot,
): DropSettingsSnapshot => ({
  mode: snapshot.mode === "offline" ? "offline" : "online",
  shareVisibility: normalizeShareVisibility(snapshot.shareVisibility),
  draftDiffPolicy: normalizeDraftDiffPolicy(snapshot.draftDiffPolicy),
  passkeyProtectionEnabled: Boolean(snapshot.passkeyProtectionEnabled),
  syntaxMode: normalizeSyntaxMode(snapshot.syntaxMode),
  allowedUrls: normalizeIframeAllowlist(snapshot.allowedUrls),
});

const settingsSnapshotFromState = (state: {
  mode: DropMode;
  shareVisibility: DropVisibility;
  draftDiffPolicy: DropDraftDiffPolicy;
  passkeyProtectionEnabled: boolean;
  syntaxMode: EditorSyntaxMode;
  allowedUrls: string[];
}): DropSettingsSnapshot => ({
  mode: state.mode,
  shareVisibility: state.shareVisibility,
  draftDiffPolicy: state.draftDiffPolicy,
  passkeyProtectionEnabled: state.passkeyProtectionEnabled,
  syntaxMode: state.syntaxMode,
  allowedUrls: [...state.allowedUrls],
});

const derivedStateFromSnapshot = (snapshot: DropSettingsSnapshot) => {
  const normalized = normalizeSettingsSnapshot(snapshot);
  const offlineMode = normalized.mode === "offline";

  return {
    mode: normalized.mode,
    settings: createSettingsObject(normalized),
    offlineMode,
    syncTargetProvider: deriveSyncTargetProvider(normalized.mode),
    shareVisibility: normalized.shareVisibility,
    unlockPolicy: deriveUnlockPolicy(normalized.mode, normalized.shareVisibility),
    draftDiffPolicy: normalized.draftDiffPolicy,
    passkeyProtectionEnabled: normalized.passkeyProtectionEnabled,
    syntaxMode: normalized.syntaxMode,
    allowedUrls: normalized.allowedUrls,
  };
};

const SETTINGS_DESCRIPTORS: {
  [K in SettingName]: SettingDescriptor<K>;
} = {
  mode: {
    storageKey: OFFLINE_MODE_KEY,
    apply: (snapshot, value) => {
      snapshot.mode = value;
    },
    serialize: (value) => serializeMode(value),
  },
  shareVisibility: {
    storageKey: SHARE_VISIBILITY_KEY,
    apply: (snapshot, value) => {
      snapshot.shareVisibility = value;
    },
    serialize: (value) => value,
  },
  draftDiffPolicy: {
    storageKey: DRAFT_DIFF_POLICY_KEY,
    apply: (snapshot, value) => {
      snapshot.draftDiffPolicy = value;
    },
    serialize: (value) => value,
  },
  passkeyProtectionEnabled: {
    storageKey: PASSKEY_PROTECTION_STORAGE_KEY,
    apply: (snapshot, value) => {
      snapshot.passkeyProtectionEnabled = value;
    },
    serialize: (value) => serializeBoolean(value),
  },
  syntaxMode: {
    storageKey: SYNTAX_MODE_KEY,
    apply: (snapshot, value) => {
      snapshot.syntaxMode = value;
    },
    serialize: (value) => value,
  },
  allowedUrls: {
    storageKey: ALLOWED_URLS_KEY,
    apply: (snapshot, value) => {
      snapshot.allowedUrls = normalizeIframeAllowlist(value);
    },
    serialize: (value) => serializeAllowedUrls(value),
  },
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
};

const buildResolutionError = (
  target: "drop" | "drop graph" | "drop ownership",
  id: string,
  localError: unknown,
  remoteError: unknown,
): Error => {
  const localReason = localError ? getErrorMessage(localError) : "not found";
  const remoteReason = remoteError ? getErrorMessage(remoteError) : "not found";

  return new Error(
    `Failed to resolve ${target} "${id}" (local: ${localReason}; remote: ${remoteReason}).`,
  );
};

const logProviderFailure = (
  operation: "getDrop" | "resolveDropGraph" | "resolveDropOwnership",
  provider: DropProviderScope,
  id: string,
  error: unknown,
) => {
  console.error(
    `[dropStore] ${operation} failed via ${provider} provider for "${id}":`,
    error,
  );
};

const buildDropUrlFromId = (id: string): string => {
  const shortId = toShortDropId(id);

  if (typeof window === "undefined") {
    return `/d/${shortId}`;
  }

  return `${window.location.origin}/d/${shortId}`;
};

const isConflictError = (error: unknown): boolean => {
  const message = getErrorMessage(error).toLowerCase();

  return (
    message.includes("409") ||
    message.includes("already in use") ||
    message.includes("already exists") ||
    message.includes("conflict")
  );
};

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

const publishLocalDropToRemote = async (
  id: string,
  visibility: DropVisibility,
  onProgress?: (progress: DropSyncProgress) => void,
): Promise<ModeTransitionResult["publishedDrop"] | undefined> => {
  const localRecord = await dropProviderRegistry.local.crud.drops.get(id);
  if (!localRecord) {
    return undefined;
  }

  onProgress?.({ phase: "start", total: 1, completed: 0, dropId: localRecord.id });

  try {
    const existingRemote = await dropProviderRegistry.remote.crud.drops.get(
      localRecord.id,
    );

    if (existingRemote) {
      onProgress?.({
        phase: "record",
        total: 1,
        completed: 1,
        dropId: existingRemote.id,
      });
      onProgress?.({
        phase: "complete",
        total: 1,
        completed: 1,
        dropId: existingRemote.id,
      });

      return {
        sourceId: localRecord.id,
        id: existingRemote.id,
        url: buildDropUrlFromId(existingRemote.id),
      };
    }
  } catch (error) {
    console.error(
      `[dropStore] Failed checking remote publication state for "${localRecord.id}":`,
      error,
    );
  }

  const payload = await dropProviderRegistry.local.get(localRecord.id);
  if (!payload) {
    return undefined;
  }

  const unlockPolicy = deriveUnlockPolicy("online", visibility);

  let created: Awaited<ReturnType<typeof dropProviderRegistry.remote.create>>;

  try {
    created = await dropProviderRegistry.remote.create(payload, {
      id: localRecord.id,
      visibility,
      unlockPolicy,
    });
  } catch (error) {
    if (!isConflictError(error)) {
      throw error;
    }

    created = await dropProviderRegistry.remote.create(payload, {
      visibility,
      unlockPolicy,
    });
  }

  onProgress?.({ phase: "record", total: 1, completed: 1, dropId: created.id });
  onProgress?.({ phase: "complete", total: 1, completed: 1, dropId: created.id });

  return {
    sourceId: localRecord.id,
    id: created.id,
    url: created.url,
  };
};

const resolveDropOwnershipRecord = async (
  id: string,
): Promise<{ id: string; ownedByCurrentAccount: boolean } | null> => {
  const { accountId } = await getUnlockedVault();
  let localError: unknown = null;

  try {
    const localRecord = await dropProviderRegistry.local.crud.drops.get(id);
    if (localRecord) {
      return {
        id: localRecord.id,
        ownedByCurrentAccount: localRecord.envelope.accountId === accountId,
      };
    }
  } catch (error) {
    localError = error;
    logProviderFailure("resolveDropOwnership", "local", id, error);
  }

  let remoteError: unknown = null;

  try {
    const remoteRecord = await dropProviderRegistry.remote.crud.drops.get(id);
    if (remoteRecord) {
      return {
        id: remoteRecord.id,
        ownedByCurrentAccount: remoteRecord.envelope.accountId === accountId,
      };
    }
  } catch (error) {
    remoteError = error;
    logProviderFailure("resolveDropOwnership", "remote", id, error);
  }

  if (localError || remoteError) {
    const resolutionError = buildResolutionError(
      "drop ownership",
      id,
      localError,
      remoteError,
    );
    console.error("[dropStore] " + resolutionError.message);
    throw resolutionError;
  }

  console.warn('[dropStore] resolveDropOwnership could not resolve "' + id + '" in local or remote providers.');

  return null;
};

const DEFAULT_SETTINGS_SNAPSHOT: DropSettingsSnapshot = {
  mode: "online",
  shareVisibility: "unlisted",
  draftDiffPolicy: "edited-only",
  passkeyProtectionEnabled: true,
  syntaxMode: "rendered",
  allowedUrls: [...DEFAULT_IFRAME_ALLOWLIST],
};

const useDropStore = create<DropStoreState>((set, get) => ({
  ...derivedStateFromSnapshot(DEFAULT_SETTINGS_SNAPSHOT),
  hydrated: false,

  hydrateOfflineMode: async () => {
    if (get().hydrated) return;

    const [storedMode, legacySyncTarget] = await Promise.all([
      readPersistedItem(OFFLINE_MODE_KEY),
      readPersistedItem(SYNC_TARGET_PROVIDER_KEY),
    ]);

    const currentSnapshot = settingsSnapshotFromState(get());
    const nextSnapshot = normalizeSettingsSnapshot({
      ...currentSnapshot,
      mode: parseModeFromStoredValue(storedMode, legacySyncTarget),
    });

    set({
      ...derivedStateFromSnapshot(nextSnapshot),
      hydrated: true,
    });

    await writePersistedItem(OFFLINE_MODE_KEY, serializeMode(nextSnapshot.mode));
  },

  hydrateSharePreferences: async () => {
    const [
      storedMode,
      storedVisibility,
      storedDraftDiffPolicy,
      storedPasskeyProtection,
      storedSyntaxMode,
      storedAllowedUrls,
      legacyUnlockPolicy,
      legacySyncTarget,
    ] = await Promise.all([
      readPersistedItem(OFFLINE_MODE_KEY),
      readPersistedItem(SHARE_VISIBILITY_KEY),
      readPersistedItem(DRAFT_DIFF_POLICY_KEY),
      readPersistedItem(PASSKEY_PROTECTION_STORAGE_KEY),
      readPersistedItem(SYNTAX_MODE_KEY),
      readPersistedItem(ALLOWED_URLS_KEY),
      readPersistedItem(UNLOCK_POLICY_KEY),
      readPersistedItem(SYNC_TARGET_PROVIDER_KEY),
    ]);

    const mode = parseModeFromStoredValue(storedMode, legacySyncTarget);
    const migratedVisibility =
      storedVisibility === null &&
      mode === "online" &&
      parseLegacyUnlockPolicy(legacyUnlockPolicy) === "vault-only"
        ? "private"
        : parseShareVisibility(storedVisibility);

    const allowedUrls = parseAllowedUrls(
      storedAllowedUrls ?? (await readPersistedItem(LEGACY_IFRAME_ALLOWLIST_KEY)),
    );

    const nextSnapshot = normalizeSettingsSnapshot({
      mode,
      shareVisibility: migratedVisibility,
      draftDiffPolicy: parseDraftDiffPolicy(storedDraftDiffPolicy),
      passkeyProtectionEnabled: parsePasskeyProtectionEnabled(
        storedPasskeyProtection,
      ),
      syntaxMode: parseSyntaxMode(storedSyntaxMode),
      allowedUrls,
    });

    set({
      ...derivedStateFromSnapshot(nextSnapshot),
      hydrated: true,
    });

    await Promise.all([
      writePersistedItem(OFFLINE_MODE_KEY, serializeMode(nextSnapshot.mode)),
      writePersistedItem(SHARE_VISIBILITY_KEY, nextSnapshot.shareVisibility),
      writePersistedItem(DRAFT_DIFF_POLICY_KEY, nextSnapshot.draftDiffPolicy),
      writePersistedItem(
        PASSKEY_PROTECTION_STORAGE_KEY,
        serializeBoolean(nextSnapshot.passkeyProtectionEnabled),
      ),
      writePersistedItem(SYNTAX_MODE_KEY, nextSnapshot.syntaxMode),
      writePersistedItem(
        ALLOWED_URLS_KEY,
        serializeAllowedUrls(nextSnapshot.allowedUrls),
      ),
    ]);
  },

  applySettings: async (changes: DropSettingsChanges) => {
    const incomingEntries = Object.entries(changes).filter(
      ([, value]) => value !== undefined,
    ) as Array<[SettingName, DropSettingsChanges[SettingName]]>;

    if (!incomingEntries.length) {
      return;
    }

    const currentSnapshot = settingsSnapshotFromState(get());
    const nextSnapshot: DropSettingsSnapshot = {
      ...currentSnapshot,
      allowedUrls: [...currentSnapshot.allowedUrls],
    };

    const changedNames = new Set<SettingName>();

    incomingEntries.forEach(([name, rawValue]) => {
      const descriptor = SETTINGS_DESCRIPTORS[name];
      const value =
        name === "allowedUrls"
          ? [...(rawValue as readonly string[])]
          : rawValue;

      descriptor.apply(nextSnapshot, value as never);
      changedNames.add(name);
    });

    const normalizedSnapshot = normalizeSettingsSnapshot(nextSnapshot);

    set({
      ...derivedStateFromSnapshot(normalizedSnapshot),
      hydrated: true,
    });

    await Promise.all(
      [...changedNames].map((name) => {
        const descriptor = SETTINGS_DESCRIPTORS[name];
        return writePersistedItem(
          descriptor.storageKey,
          descriptor.serialize(normalizedSnapshot[name] as never),
        );
      }),
    );
  },

  setMode: async (
    mode: DropMode,
    options: ModeTransitionOptions = {},
  ): Promise<ModeTransitionResult> => {
    const currentMode = get().mode;

    if (currentMode === mode) {
      return { mode };
    }

    await get().applySettings({ mode });

    let publishedDrop: ModeTransitionResult["publishedDrop"];

    if (currentMode === "offline" && mode === "online" && options.activeDropId) {
      publishedDrop = await publishLocalDropToRemote(
        options.activeDropId,
        get().shareVisibility,
        options.onProgress,
      );
    }

    return {
      mode,
      publishedDrop,
    };
  },

  setOfflineMode: async (
    enabled: boolean,
    options: ModeTransitionOptions = {},
  ) => {
    return get().setMode(enabled ? "offline" : "online", options);
  },

  setSyncTargetProvider: async (scope: DropProviderScope) => {
    await get().setMode(scope === "local" ? "offline" : "online");
  },

  setShareVisibility: async (visibility: DropVisibility) => {
    await get().applySettings({ shareVisibility: visibility });
  },

  setUnlockPolicy: async (policy: DropUnlockPolicy) => {
    if (policy === "vault-only") {
      await get().applySettings({ shareVisibility: "private" });
      return;
    }

    if (get().shareVisibility === "private") {
      await get().applySettings({ shareVisibility: "unlisted" });
    }
  },

  setDraftDiffPolicy: async (policy: DropDraftDiffPolicy) => {
    await get().applySettings({ draftDiffPolicy: policy });
  },

  setPasskeyProtectionEnabled: async (enabled: boolean) => {
    await get().applySettings({ passkeyProtectionEnabled: enabled });
  },

  setSyntaxMode: async (mode: EditorSyntaxMode) => {
    await get().applySettings({ syntaxMode: mode });
  },

  setAllowedUrls: async (urls: readonly string[]) => {
    await get().applySettings({ allowedUrls: urls });
  },

  createDrop: async (payload: DropPayload, options: Partial<DropCreateOptions> = {}) => {
    await Promise.all([
      get().hydrateOfflineMode(),
      get().hydrateSharePreferences(),
    ]);

    const mode = get().mode;
    const visibility = resolveCreateVisibility(
      mode,
      options.visibility ?? get().shareVisibility,
    );
    const unlockPolicy = deriveUnlockPolicy(mode, visibility);

    const localCreated = await dropProviderRegistry.local.create(payload, {
      visibility,
      unlockPolicy,
      id: options.id,
      upsert: options.upsert,
    });

    if (mode === "offline") {
      return localCreated;
    }

    const syncResult = await dropProviderRegistry.local.sync(
      dropProviderRegistry.remote,
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
    const published = await publishLocalDropToRemote(
      id,
      get().shareVisibility,
      onProgress,
    );

    if (!published) {
      throw new Error(`Drop "${id}" was not found in local storage.`);
    }
  },

  getDrop: async (id: string) => {
    let localError: unknown = null;

    try {
      const local = await dropProviderRegistry.local.get(id);
      if (local) {
        return local;
      }
    } catch (error) {
      localError = error;
      logProviderFailure("getDrop", "local", id, error);
    }

    let remoteError: unknown = null;

    try {
      const remote = await dropProviderRegistry.remote.get(id);
      if (remote) {
        return remote;
      }
    } catch (error) {
      remoteError = error;
      logProviderFailure("getDrop", "remote", id, error);
    }

    if (localError || remoteError) {
      const resolutionError = buildResolutionError("drop", id, localError, remoteError);
      console.error(`[dropStore] ${resolutionError.message}`);
      throw resolutionError;
    }

    console.warn(
      `[dropStore] getDrop could not resolve "${id}" in local or remote providers.`,
    );

    return null;
  },

  resolveDropOwnership: async (id: string) => {
    return resolveDropOwnershipRecord(id);
  },

  resolveDropGraph: async (id: string) => {
    let localError: unknown = null;

    try {
      return await dropProviderRegistry.local.resolveGraph(id);
    } catch (error) {
      localError = error;
      logProviderFailure("resolveDropGraph", "local", id, error);
    }

    try {
      return await dropProviderRegistry.remote.resolveGraph(id);
    } catch (remoteError) {
      logProviderFailure("resolveDropGraph", "remote", id, remoteError);
      const resolutionError = buildResolutionError(
        "drop graph",
        id,
        localError,
        remoteError,
      );
      console.error(`[dropStore] ${resolutionError.message}`);
      throw resolutionError;
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
    const result = await dropProviderRegistry.local.create(payload, {
      visibility: "private",
      unlockPolicy: "vault-only",
    });

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

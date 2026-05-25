/*
Drop store is the stateful coordinator for mode, visibility, provider routing, local-first
publishing, and sync conflict resolution. Local sealed drops are always created first;
remote publication is modeled as a queued follow-up so offline editing and recovery paths
share one code path.
*/

import { create } from "zustand";
import { toShortDropId } from "../../shared/drop/id";
import {
  getKvItem,
  getKvValue,
  isIndexedDbSupported,
  setKvItem,
  setKvValue,
} from "../lib/indexedDb";
import {
  getDefaultDropProviderRegistry,
  isDropProviderHttpError,
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
  DropEnvelopeV1,
  DropDraftDiffPolicy,
  DropGraph,
  DropMetadata,
  DropPayload,
  DropUnlockPolicy,
  DropVisibility,
} from "../../shared/drop/types";
import { serializeCanonicalJson } from "../../shared/drop/types";
import {
  isDropSyncConflictRecordList,
  isDropSyncQueueEntryList,
  type DropSyncPublishSource,
  type DropSyncQueueEntry,
  type DropSyncConflictRecord,
  type DropSyncConflictResolution,
} from "../../shared/drop/sync";
import {
  DEFAULT_NETWORK_ALLOWLIST,
  normalizeNetworkAllowlist,
  parseNetworkAllowlistInput,
} from "../lib/networkAllowlist";

const OFFLINE_MODE_KEY = "nulldown_offline_mode";
const SHARE_VISIBILITY_KEY = "nulldown_share_visibility";
const UNLOCK_POLICY_KEY = "nulldown_unlock_policy";
const SYNC_TARGET_PROVIDER_KEY = "nulldown_sync_target_provider";
const DRAFT_DIFF_POLICY_KEY = "nulldown_draft_diff_policy";
const NETWORK_ALLOWLIST_KEY = "nulldown_network_allowlist";
const SYNTAX_MODE_KEY = "nulldown_syntax_mode";
const SYNC_CONFLICTS_KEY = "nulldown_sync_conflicts_v1";
const SYNC_QUEUE_KEY = "nulldown_sync_queue_v1";

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
  network: {
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

type PublishSyncSource = DropSyncPublishSource;

interface PublishSyncIntent {
  dropId: string;
  visibility: DropVisibility;
  source: PublishSyncSource;
  queuedAt: number;
  waiters: Array<{
    resolve: (value: ModeTransitionResult["publishedDrop"] | undefined) => void;
    reject: (error: unknown) => void;
    onProgress?: (progress: DropSyncProgress) => void;
  }>;
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
  syncGuardActive: boolean;
  syncQueueDepth: number;
  syncConflicts: DropSyncConflictRecord[];
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
  listSyncConflicts: () => DropSyncConflictRecord[];
  resolveSyncConflict: (
    conflictId: string,
    resolution: DropSyncConflictResolution,
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
  value === null ? false : value === "1" || value === "true";

const parseAllowedUrls = (value: string | null): string[] => {
  if (!value) {
    return [...DEFAULT_NETWORK_ALLOWLIST];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return normalizeNetworkAllowlist(
        parsed.filter((entry): entry is string => typeof entry === "string"),
      );
    }
  } catch {
    return parseNetworkAllowlistInput(value);
  }

  return parseNetworkAllowlistInput(value);
};

const serializeMode = (mode: DropMode) => mode;

const serializeBoolean = (enabled: boolean) => (enabled ? "1" : "0");

const serializeAllowedUrls = (urls: readonly string[]): string =>
  JSON.stringify(normalizeNetworkAllowlist(urls));

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
  network: {
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
  allowedUrls: normalizeNetworkAllowlist(snapshot.allowedUrls),
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
    storageKey: NETWORK_ALLOWLIST_KEY,
    apply: (snapshot, value) => {
      snapshot.allowedUrls = normalizeNetworkAllowlist(value);
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
  if (isDropProviderHttpError(error)) {
    return error.status === 409 || error.status === 412;
  }

  const message = getErrorMessage(error).toLowerCase();

  return (
    message.includes("409") ||
    message.includes("412") ||
    message.includes("precondition") ||
    message.includes("already in use") ||
    message.includes("already exists") ||
    message.includes("conflict")
  );
};

const getConflictReasonFromError = (
  error: unknown,
): DropSyncConflictRecord["reason"] => {
  if (isDropProviderHttpError(error)) {
    if (
      error.status === 412 ||
      error.code === "revision_precondition_failed"
    ) {
      return "remote_state_mismatch";
    }

    if (error.status === 409) {
      return "remote_id_conflict";
    }
  }

  const message = getErrorMessage(error).toLowerCase();
  if (message.includes("412") || message.includes("precondition")) {
    return "remote_state_mismatch";
  }

  return "remote_id_conflict";
};

const getConflictCodeFromError = (error: unknown): string | null => {
  if (isDropProviderHttpError(error)) {
    if (error.code) {
      return error.code;
    }

    if (error.status === 412) {
      return "revision_precondition_failed";
    }

    if (error.status === 409) {
      return "remote_id_conflict";
    }
  }

  const message = getErrorMessage(error).toLowerCase();
  if (message.includes("412") || message.includes("precondition")) {
    return "revision_precondition_failed";
  }

  if (message.includes("409") || message.includes("conflict")) {
    return "remote_id_conflict";
  }

  return null;
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

const readPersistedValue = async <T>(key: string): Promise<T | null> => {
  if (isIndexedDbSupported()) {
    try {
      const value = await getKvValue<T>(key);
      if (value !== null) {
        return value;
      }
    } catch (error) {
      console.error(`Failed reading "${key}" object value from IndexedDB:`, error);
    }
  }

  const raw = readLocalStorageItem(key);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const writePersistedValue = async (key: string, value: unknown) => {
  if (isIndexedDbSupported()) {
    try {
      await setKvValue(key, value);
      return;
    } catch (error) {
      console.error(`Failed writing "${key}" object value to IndexedDB:`, error);
    }
  }

  writeLocalStorageItem(key, JSON.stringify(value));
};

const createSyncRecordId = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `sync_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};

const resolveDropOwnershipRecord = async (
  id: string,
): Promise<{ id: string; ownedByCurrentAccount: boolean } | null> => {
  const { accountId } = await getUnlockedVault();

  const resolveLegacyOwnership = async (
    scope: DropProviderScope,
  ): Promise<{ id: string; ownedByCurrentAccount: boolean } | null> => {
    if (scope === "local") {
      const payload = await dropProviderRegistry.local.get(id);
      const ownerAccountId =
        typeof payload?.metadata?.ownerAccountId === "string"
          ? payload.metadata.ownerAccountId
          : null;

      if (!ownerAccountId) {
        return null;
      }

      return {
        id,
        ownedByCurrentAccount: ownerAccountId === accountId,
      };
    }

    const response = await fetch(`/api/get/${encodeURIComponent(id)}`);
    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error((await response.text()) || `Failed to fetch drop: ${response.statusText}`);
    }

    const canonicalId = response.headers.get("X-Drop-Canonical-Id") || id;
    const contentType = response.headers.get("Content-Type") || "";
    if (!contentType.includes("application/json")) {
      return null;
    }

    const payload = (await response.json()) as unknown;
    if (!payload || typeof payload !== "object") {
      return null;
    }

    const ownerAccountId =
      typeof (payload as { metadata?: { ownerAccountId?: unknown } }).metadata
        ?.ownerAccountId === "string"
        ? (payload as { metadata: { ownerAccountId: string } }).metadata.ownerAccountId
        : null;

    if (!ownerAccountId) {
      return null;
    }

    return {
      id: canonicalId,
      ownedByCurrentAccount: ownerAccountId === accountId,
    };
  };

  let localError: unknown = null;

  try {
    const localRecord = await dropProviderRegistry.local.crud.drops.get(id);
    if (localRecord) {
      return {
        id: localRecord.id,
        ownedByCurrentAccount: localRecord.envelope.accountId === accountId,
      };
    }

    const localLegacy = await resolveLegacyOwnership("local");
    if (localLegacy) {
      return localLegacy;
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

    const remoteLegacy = await resolveLegacyOwnership("remote");
    if (remoteLegacy) {
      return remoteLegacy;
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
    console.error(`[dropStore] ${resolutionError.message}`);
    throw resolutionError;
  }

  console.warn(
    `[dropStore] resolveDropOwnership could not resolve "${id}" in local or remote providers.`,
  );

  return null;
};

const DEFAULT_SETTINGS_SNAPSHOT: DropSettingsSnapshot = {
  mode: "online",
  shareVisibility: "unlisted",
  draftDiffPolicy: "edited-only",
  passkeyProtectionEnabled: false,
  syntaxMode: "rendered",
  allowedUrls: [...DEFAULT_NETWORK_ALLOWLIST],
};

const useDropStore = create<DropStoreState>((set, get) => {
  const pendingPublishIntents = new Map<string, PublishSyncIntent>();
  let publishLoopPromise: Promise<void> | null = null;
  let syncConflictsHydrated = false;
  let syncQueueHydrated = false;

  const setSyncRuntimeState = () => {
    set({
      syncGuardActive: publishLoopPromise !== null,
      syncQueueDepth: pendingPublishIntents.size,
    });
  };

  const persistSyncConflicts = async (conflicts: DropSyncConflictRecord[]) => {
    await writePersistedValue(SYNC_CONFLICTS_KEY, conflicts);
  };

  const toPersistedQueueEntries = (): DropSyncQueueEntry[] =>
    [...pendingPublishIntents.values()]
      .map((intent) => ({
        version: 1 as const,
        dropId: intent.dropId,
        visibility: intent.visibility,
        source: intent.source,
        queuedAt: intent.queuedAt,
      }))
      .sort((a, b) => a.queuedAt - b.queuedAt);

  const persistSyncQueue = async (): Promise<void> => {
    await writePersistedValue(SYNC_QUEUE_KEY, toPersistedQueueEntries());
  };

  const hydrateSyncQueue = async (): Promise<void> => {
    if (syncQueueHydrated) {
      return;
    }

    const persisted = await readPersistedValue<unknown>(SYNC_QUEUE_KEY);
    const entries = isDropSyncQueueEntryList(persisted) ? persisted : [];
    entries.forEach((entry) => {
      // Waiters are runtime-only; persisted queue entries only restore the work that still needs publishing.
      pendingPublishIntents.set(entry.dropId, {
        dropId: entry.dropId,
        visibility: entry.visibility,
        source: entry.source,
        queuedAt: entry.queuedAt,
        waiters: [],
      });
    });
    syncQueueHydrated = true;
    setSyncRuntimeState();
  };

  const hydrateSyncConflicts = async (): Promise<void> => {
    if (syncConflictsHydrated) {
      return;
    }

    const persisted = await readPersistedValue<unknown>(SYNC_CONFLICTS_KEY);
    const conflicts = isDropSyncConflictRecordList(persisted) ? persisted : [];
    syncConflictsHydrated = true;
    set({ syncConflicts: conflicts });
  };

  const getPendingConflictForDrop = (dropId: string): DropSyncConflictRecord | null => {
    const conflicts = get().syncConflicts;
    return (
      conflicts.find(
        (entry) => entry.dropId === dropId && entry.status === "pending",
      ) ?? null
    );
  };

  const persistConflictRecord = async (
    conflict: DropSyncConflictRecord,
  ): Promise<DropSyncConflictRecord> => {
    const next = [...get().syncConflicts];
    const existingIndex = next.findIndex((entry) => entry.id === conflict.id);
    if (existingIndex >= 0) {
      next[existingIndex] = conflict;
    } else {
      next.unshift(conflict);
    }
    set({ syncConflicts: next });
    await persistSyncConflicts(next);
    return conflict;
  };

  const createConflictRecord = async (input: {
    dropId: string;
    reason: DropSyncConflictRecord["reason"];
    code?: string | null;
    local: {
      id: string;
      envelope: DropEnvelopeV1;
      createdAt: number;
      updatedAt: number;
      revision?: string | null;
    };
    remote: {
      id: string;
      envelope: DropEnvelopeV1;
      createdAt: number;
      updatedAt: number;
      revision?: string | null;
    } | null;
  }): Promise<DropSyncConflictRecord> => {
    const existing = getPendingConflictForDrop(input.dropId);
    if (existing) {
      const refreshed: DropSyncConflictRecord = {
        ...existing,
        reason: input.reason,
        code: input.code ?? existing.code,
        local: input.local,
        remote: input.remote,
      };
      return persistConflictRecord(refreshed);
    }

    const created: DropSyncConflictRecord = {
      version: 1,
      id: createSyncRecordId(),
      dropId: input.dropId,
      opKind: "publish",
      reason: input.reason,
      code: input.code ?? null,
      status: "pending",
      local: input.local,
      remote: input.remote,
      createdAt: Date.now(),
    };

    return persistConflictRecord(created);
  };

  const emitIntentProgress = (
    intent: PublishSyncIntent,
    progress: DropSyncProgress,
  ): void => {
    intent.waiters.forEach((waiter) => {
      waiter.onProgress?.(progress);
    });
  };

  const envelopeHash = (envelope: DropEnvelopeV1): string =>
    serializeCanonicalJson(envelope);

  const runPublishIntent = async (
    intent: PublishSyncIntent,
  ): Promise<ModeTransitionResult["publishedDrop"] | undefined> => {
    const localRecord = await dropProviderRegistry.local.crud.drops.get(intent.dropId);
    if (!localRecord) {
      return undefined;
    }

    emitIntentProgress(intent, {
      phase: "start",
      total: 1,
      completed: 0,
      dropId: localRecord.id,
    });

    const remoteRecord = await dropProviderRegistry.remote.crud.drops.get(localRecord.id);
    if (remoteRecord) {
      const localHash = serializeCanonicalJson(localRecord.envelope);
      const remoteHash = serializeCanonicalJson(remoteRecord.envelope);

      if (localHash !== remoteHash) {
        // Once remote state diverges, publishing stops and hands control to explicit conflict resolution.
        await createConflictRecord({
          dropId: localRecord.id,
          reason: "remote_state_mismatch",
          code: "remote_state_mismatch",
          local: {
            id: localRecord.id,
            envelope: localRecord.envelope,
            createdAt: localRecord.createdAt,
            updatedAt: localRecord.updatedAt,
            revision: localRecord.revision ?? null,
          },
          remote: {
            id: remoteRecord.id,
            envelope: remoteRecord.envelope,
            createdAt: remoteRecord.createdAt,
            updatedAt: remoteRecord.updatedAt,
            revision: remoteRecord.revision ?? null,
          },
        });

        throw new Error(
          `Sync conflict for drop "${localRecord.id}". Resolve it before publishing again.`,
        );
      }

      emitIntentProgress(intent, {
        phase: "record",
        total: 1,
        completed: 1,
        dropId: remoteRecord.id,
      });
      emitIntentProgress(intent, {
        phase: "complete",
        total: 1,
        completed: 1,
        dropId: remoteRecord.id,
      });

      return {
        sourceId: localRecord.id,
        id: remoteRecord.id,
        url: buildDropUrlFromId(remoteRecord.id),
      };
    }

    const payload = await dropProviderRegistry.local.get(localRecord.id);
    if (!payload) {
      return undefined;
    }

    const unlockPolicy = deriveUnlockPolicy("online", intent.visibility);

    try {
      const created = await dropProviderRegistry.remote.create(payload, {
        id: localRecord.id,
        visibility: intent.visibility,
        unlockPolicy,
      });

      emitIntentProgress(intent, {
        phase: "record",
        total: 1,
        completed: 1,
        dropId: created.id,
      });
      emitIntentProgress(intent, {
        phase: "complete",
        total: 1,
        completed: 1,
        dropId: created.id,
      });

      return {
        sourceId: localRecord.id,
        id: created.id,
        url: created.url,
      };
    } catch (error) {
      if (!isConflictError(error)) {
        throw error;
      }

      const conflictReason = getConflictReasonFromError(error);
      const conflictCode = getConflictCodeFromError(error);
      const competing = await dropProviderRegistry.remote.crud.drops.get(localRecord.id);
      if (competing) {
        await createConflictRecord({
          dropId: localRecord.id,
          reason: conflictReason,
          code: conflictCode,
          local: {
            id: localRecord.id,
            envelope: localRecord.envelope,
            createdAt: localRecord.createdAt,
            updatedAt: localRecord.updatedAt,
            revision: localRecord.revision ?? null,
          },
          remote: {
            id: competing.id,
            envelope: competing.envelope,
            createdAt: competing.createdAt,
            updatedAt: competing.updatedAt,
            revision: competing.revision ?? null,
          },
        });

        throw new Error(
          `Sync conflict for drop "${localRecord.id}". Resolve it before publishing again.`,
        );
      }

      throw error;
    }
  };

  const ensurePublishLoop = async () => {
    await hydrateSyncQueue();

    if (publishLoopPromise) {
      return publishLoopPromise;
    }

    publishLoopPromise = (async () => {
      setSyncRuntimeState();
      while (pendingPublishIntents.size > 0) {
        const firstEntry = pendingPublishIntents.entries().next().value as
          | [string, PublishSyncIntent]
          | undefined;
        if (!firstEntry) {
          break;
        }

        const [dropId, intent] = firstEntry;
        pendingPublishIntents.delete(dropId);
        setSyncRuntimeState();
        await persistSyncQueue();

        try {
          // Intents run one-at-a-time so conflict handling sees a stable local/remote pair.
          const published = await runPublishIntent(intent);
          intent.waiters.forEach((waiter) => waiter.resolve(published));
        } catch (error) {
          intent.waiters.forEach((waiter) => waiter.reject(error));
        }
      }
    })();

    try {
      await publishLoopPromise;
    } finally {
      publishLoopPromise = null;
      setSyncRuntimeState();
    }
  };

  const enqueuePublishIntent = async (input: {
    dropId: string;
    visibility: DropVisibility;
    source: PublishSyncSource;
    onProgress?: (progress: DropSyncProgress) => void;
  }): Promise<ModeTransitionResult["publishedDrop"] | undefined> => {
    await hydrateSyncConflicts();
    await hydrateSyncQueue();

    const pendingConflict = getPendingConflictForDrop(input.dropId);
    if (pendingConflict) {
      throw new Error(
        `Drop "${input.dropId}" has a pending sync conflict (${pendingConflict.id}). Resolve it first.`,
      );
    }

    return new Promise<ModeTransitionResult["publishedDrop"] | undefined>(
      (resolve, reject) => {
        const existing = pendingPublishIntents.get(input.dropId);
        if (existing) {
          existing.visibility = input.visibility;
          existing.source = input.source;
          existing.waiters.push({ resolve, reject, onProgress: input.onProgress });
        } else {
          const queuedAt = Date.now();
          pendingPublishIntents.set(input.dropId, {
            dropId: input.dropId,
            visibility: input.visibility,
            source: input.source,
            queuedAt,
            waiters: [{ resolve, reject, onProgress: input.onProgress }],
          });
        }

        setSyncRuntimeState();
        void persistSyncQueue();
        void ensurePublishLoop();
      },
    );
  };

  const resolveConflictRecord = async (
    conflictId: string,
    resolution: DropSyncConflictResolution,
  ): Promise<void> => {
    await hydrateSyncConflicts();

    const conflicts = [...get().syncConflicts];
    const index = conflicts.findIndex((entry) => entry.id === conflictId);
    if (index < 0) {
      throw new Error(`Sync conflict "${conflictId}" was not found.`);
    }

    const target = conflicts[index];
    if (target.status !== "pending") {
      return;
    }

    if (resolution === "accept-local") {
      const latestRemote = target.remote
        ? await dropProviderRegistry.remote.crud.drops.get(target.dropId)
        : null;

      if (target.remote) {
        if (
          latestRemote &&
          envelopeHash(latestRemote.envelope) !== envelopeHash(target.remote.envelope)
        ) {
          const refreshedConflict: DropSyncConflictRecord = {
            ...target,
            remote: {
              id: latestRemote.id,
              envelope: latestRemote.envelope,
              createdAt: latestRemote.createdAt,
              updatedAt: latestRemote.updatedAt,
              revision: latestRemote.revision ?? null,
            },
          };
          conflicts[index] = refreshedConflict;
          set({ syncConflicts: conflicts });
          await persistSyncConflicts(conflicts);
          throw new Error(
            `Remote state changed for drop "${target.dropId}". Review the refreshed conflict before resolving.`,
          );
        }
      }

      const localRecord =
        (await dropProviderRegistry.local.crud.drops.get(target.dropId)) ?? {
          id: target.local.id,
          envelope: target.local.envelope,
          createdAt: target.local.createdAt,
          updatedAt: target.local.updatedAt,
          revision: target.local.revision ?? null,
        };

      try {
        await dropProviderRegistry.remote.crud.drops.create(localRecord, {
          upsert: true,
          expectedRevision:
            latestRemote?.revision ?? target.remote?.revision ?? undefined,
        });
      } catch (error) {
        if (!isConflictError(error)) {
          throw error;
        }

        const refreshedRemote = await dropProviderRegistry.remote.crud.drops.get(
          target.dropId,
        );
        if (refreshedRemote) {
          conflicts[index] = {
            ...target,
            remote: {
              id: refreshedRemote.id,
              envelope: refreshedRemote.envelope,
              createdAt: refreshedRemote.createdAt,
              updatedAt: refreshedRemote.updatedAt,
              revision: refreshedRemote.revision ?? null,
            },
          };
          set({ syncConflicts: conflicts });
          await persistSyncConflicts(conflicts);
        }

        throw new Error(
          `Remote state changed for drop "${target.dropId}" while resolving. Review the refreshed conflict and retry.`,
        );
      }
    } else {
      const latestLocal = await dropProviderRegistry.local.crud.drops.get(
        target.dropId,
      );
      if (
        latestLocal &&
        envelopeHash(latestLocal.envelope) !== envelopeHash(target.local.envelope)
      ) {
        const refreshedConflict: DropSyncConflictRecord = {
          ...target,
          local: {
            id: latestLocal.id,
            envelope: latestLocal.envelope,
            createdAt: latestLocal.createdAt,
            updatedAt: latestLocal.updatedAt,
            revision: latestLocal.revision ?? null,
          },
        };
        conflicts[index] = refreshedConflict;
        set({ syncConflicts: conflicts });
        await persistSyncConflicts(conflicts);
        throw new Error(
          `Local state changed for drop "${target.dropId}". Review the refreshed conflict before resolving.`,
        );
      }

      if (!target.remote) {
        throw new Error(
          `Sync conflict "${conflictId}" does not have a remote candidate to accept.`,
        );
      }

      await dropProviderRegistry.local.crud.drops.create(
        {
          id: target.remote.id,
          envelope: target.remote.envelope,
          createdAt: target.remote.createdAt,
          updatedAt: Date.now(),
          revision: target.remote.revision ?? null,
        },
        { upsert: true },
      );
    }

    conflicts[index] = {
      ...target,
      status: "resolved",
      resolution,
      resolvedAt: Date.now(),
    };

    set({ syncConflicts: conflicts });
    await persistSyncConflicts(conflicts);
  };

  return {
  ...derivedStateFromSnapshot(DEFAULT_SETTINGS_SNAPSHOT),
  hydrated: false,
  syncGuardActive: false,
  syncQueueDepth: 0,
  syncConflicts: [],

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
    await hydrateSyncConflicts();
    await hydrateSyncQueue();
    if (pendingPublishIntents.size > 0) {
      void ensurePublishLoop();
    }

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
      readPersistedItem(NETWORK_ALLOWLIST_KEY),
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

    const allowedUrls = parseAllowedUrls(storedAllowedUrls);

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
        NETWORK_ALLOWLIST_KEY,
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
      publishedDrop = await enqueuePublishIntent({
        dropId: options.activeDropId,
        visibility: get().shareVisibility,
        source: "mode_transition",
        onProgress: options.onProgress,
      });
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
    if (!get().hydrated) {
      await Promise.all([
        get().hydrateOfflineMode(),
        get().hydrateSharePreferences(),
      ]);
    }

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

    // Online mode still stages the sealed drop locally first so share retries do not lose work.
    const published = await enqueuePublishIntent({
      dropId: localCreated.id,
      visibility,
      source: "create_online",
    });

    if (!published) {
      throw new Error("Failed to publish this drop to the remote provider.");
    }

    return {
      id: published.id,
      url: published.url,
      scope: "remote",
    };
  },

  syncDropToRemote: async (
    id: string,
    onProgress?: (progress: DropSyncProgress) => void,
  ) => {
    const published = await enqueuePublishIntent({
      dropId: id,
      visibility: get().shareVisibility,
      source: "manual_sync",
      onProgress,
    });

    if (!published) {
      throw new Error(`Drop "${id}" was not found in local storage.`);
    }
  },

  listSyncConflicts: () => {
    return [...get().syncConflicts].sort((a, b) => b.createdAt - a.createdAt);
  },

  resolveSyncConflict: async (
    conflictId: string,
    resolution: DropSyncConflictResolution,
  ) => {
    await resolveConflictRecord(conflictId, resolution);
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
  };
});

export type { DropGraph, DropMetadata, DropPayload };
export { isOfflineDropId, OFFLINE_DROP_PREFIX };

export default useDropStore;

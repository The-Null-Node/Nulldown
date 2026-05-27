/*
Drop store is the stateful coordinator for mode, visibility, provider routing, local-first
publishing, and sync conflict resolution. Local sealed drops are always created first;
remote publication is modeled as a queued follow-up so offline editing and recovery paths
share one code path.
*/

import { create } from "zustand";
import { toShortDropId } from "../../shared/drop/id";
import {
  getDefaultVoidProviderRegistry,
  isVoidProviderHttpError,
  isOfflineDropId,
  OFFLINE_DROP_PREFIX,
  type VoidCreateOptions,
  type VoidProviderScope,
  type VoidSyncProgress,
} from "../lib/void/provider";
import { getUnlockedVault } from "../lib/void/vault/passkeyVault";
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
  DEFAULT_SETTINGS_SNAPSHOT,
  DRAFT_DIFF_POLICY_KEY,
  NETWORK_ALLOWLIST_KEY,
  OFFLINE_MODE_KEY,
  PASSKEY_PROTECTION_STORAGE_KEY,
  SETTINGS_DESCRIPTORS,
  SHARE_VISIBILITY_KEY,
  SYNTAX_MODE_KEY,
  UNLOCK_POLICY_KEY,
  derivedStateFromSnapshot,
  deriveUnlockPolicy,
  normalizeSettingsSnapshot,
  parseAllowedUrls,
  parseDraftDiffPolicy,
  parseLegacyUnlockPolicy,
  parseModeFromStoredValue,
  parsePasskeyProtectionEnabled,
  parseShareVisibility,
  parseSyntaxMode,
  readPersistedItem,
  readPersistedValue,
  resolveCreateVisibility,
  serializeAllowedUrls,
  serializeBoolean,
  serializeMode,
  settingsSnapshotFromState,
  writePersistedItem,
  writePersistedValue,
  type DropMode,
  type DropSettingsChanges,
  type DropSettingsSnapshot,
  type DropSettingsState,
  type EditorSyntaxMode,
  type SettingName,
} from "./drop/settings";

const SYNC_TARGET_PROVIDER_KEY = "nulldown_sync_target_provider";
const SYNC_CONFLICTS_KEY = "nulldown_sync_conflicts_v1";
const SYNC_QUEUE_KEY = "nulldown_sync_queue_v1";

const voidProviderRegistry = getDefaultVoidProviderRegistry();

export interface OwnedDropRecord {
  id: string;
  visibility: DropVisibility;
  createdAt: number;
  updatedAt: number;
}

export type { DropMode, DropSettingsState, EditorSyntaxMode } from "./drop/settings";

export interface ModeTransitionOptions {
  activeDropId?: string | null;
  onProgress?: (progress: VoidSyncProgress) => void;
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
      onProgress?: (progress: VoidSyncProgress) => void;
    }>;
  }

interface DropStoreState {
  mode: DropMode;
  settings: DropSettingsState;
  offlineMode: boolean;
  syncTargetProvider: VoidProviderScope;
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
  setSyncTargetProvider: (scope: VoidProviderScope) => Promise<void>;
  setShareVisibility: (visibility: DropVisibility) => Promise<void>;
  setUnlockPolicy: (policy: DropUnlockPolicy) => Promise<void>;
  setDraftDiffPolicy: (policy: DropDraftDiffPolicy) => Promise<void>;
  setPasskeyProtectionEnabled: (enabled: boolean) => Promise<void>;
  setSyntaxMode: (mode: EditorSyntaxMode) => Promise<void>;
  setAllowedUrls: (urls: readonly string[]) => Promise<void>;
  createDrop: (
    payload: DropPayload,
    options?: Partial<VoidCreateOptions>,
  ) => Promise<{ id: string; url: string; scope: VoidProviderScope }>;
  syncDropToRemote: (
    id: string,
    onProgress?: (progress: VoidSyncProgress) => void,
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
  provider: VoidProviderScope,
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
  if (isVoidProviderHttpError(error)) {
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
  if (isVoidProviderHttpError(error)) {
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
  if (isVoidProviderHttpError(error)) {
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
    scope: VoidProviderScope,
  ): Promise<{ id: string; ownedByCurrentAccount: boolean } | null> => {
    if (scope === "local") {
      const payload = await voidProviderRegistry.local.get(id);
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
    const localRecord = await voidProviderRegistry.local.crud.drops.get(id);
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
    const remoteRecord = await voidProviderRegistry.remote.crud.drops.get(id);
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
    progress: VoidSyncProgress,
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
    const localRecord = await voidProviderRegistry.local.crud.drops.get(intent.dropId);
    if (!localRecord) {
      return undefined;
    }

    emitIntentProgress(intent, {
      phase: "start",
      total: 1,
      completed: 0,
      dropId: localRecord.id,
    });

    const remoteRecord = await voidProviderRegistry.remote.crud.drops.get(localRecord.id);
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

    const payload = await voidProviderRegistry.local.get(localRecord.id);
    if (!payload) {
      return undefined;
    }

    const unlockPolicy = deriveUnlockPolicy("online", intent.visibility);

    try {
      const created = await voidProviderRegistry.remote.create(payload, {
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
      const competing = await voidProviderRegistry.remote.crud.drops.get(localRecord.id);
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
    onProgress?: (progress: VoidSyncProgress) => void;
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
        ? await voidProviderRegistry.remote.crud.drops.get(target.dropId)
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
        (await voidProviderRegistry.local.crud.drops.get(target.dropId)) ?? {
          id: target.local.id,
          envelope: target.local.envelope,
          createdAt: target.local.createdAt,
          updatedAt: target.local.updatedAt,
          revision: target.local.revision ?? null,
        };

      try {
        await voidProviderRegistry.remote.crud.drops.create(localRecord, {
          upsert: true,
          expectedRevision:
            latestRemote?.revision ?? target.remote?.revision ?? undefined,
        });
      } catch (error) {
        if (!isConflictError(error)) {
          throw error;
        }

        const refreshedRemote = await voidProviderRegistry.remote.crud.drops.get(
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
      const latestLocal = await voidProviderRegistry.local.crud.drops.get(
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

      await voidProviderRegistry.local.crud.drops.create(
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

  setSyncTargetProvider: async (scope: VoidProviderScope) => {
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

  createDrop: async (payload: DropPayload, options: Partial<VoidCreateOptions> = {}) => {
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

    const localCreated = await voidProviderRegistry.local.create(payload, {
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
    onProgress?: (progress: VoidSyncProgress) => void,
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
      const local = await voidProviderRegistry.local.get(id);
      if (local) {
        return local;
      }
    } catch (error) {
      localError = error;
      logProviderFailure("getDrop", "local", id, error);
    }

    let remoteError: unknown = null;

    try {
      const remote = await voidProviderRegistry.remote.get(id);
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
      return await voidProviderRegistry.local.resolveGraph(id);
    } catch (error) {
      localError = error;
      logProviderFailure("resolveDropGraph", "local", id, error);
    }

    try {
      return await voidProviderRegistry.remote.resolveGraph(id);
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
      ReturnType<typeof voidProviderRegistry.local.crud.drops.list>
    >;

    try {
      records = await voidProviderRegistry.local.crud.drops.list();
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
    const result = await voidProviderRegistry.local.create(payload, {
      visibility: "private",
      unlockPolicy: "vault-only",
    });

    return {
      id: result.id,
      url: result.url,
    };
  },

  getOfflineDrop: async (id: string) => {
    return voidProviderRegistry.local.get(id);
  },
  };
});

export type { DropGraph, DropMetadata, DropPayload };
export { isOfflineDropId, OFFLINE_DROP_PREFIX };

export default useDropStore;

import type { VoidProviderScope } from "../../lib/void/provider";
import { PASSKEY_PROTECTION_STORAGE_KEY } from "../../lib/void/vault/passkeyVault";
import {
  getKvItem,
  getKvValue,
  isIndexedDbSupported,
  setKvItem,
  setKvValue,
} from "../../lib/indexedDb";
import {
  DEFAULT_NETWORK_ALLOWLIST,
  normalizeNetworkAllowlist,
  parseNetworkAllowlistInput,
} from "../../lib/networkAllowlist";
import type {
  DropDraftDiffPolicy,
  DropUnlockPolicy,
  DropVisibility,
} from "../../../shared/drop/types";

export const OFFLINE_MODE_KEY = "nulldown_offline_mode";
export const SHARE_VISIBILITY_KEY = "nulldown_share_visibility";
export const UNLOCK_POLICY_KEY = "nulldown_unlock_policy";
export const DRAFT_DIFF_POLICY_KEY = "nulldown_draft_diff_policy";
export const NETWORK_ALLOWLIST_KEY = "nulldown_network_allowlist";
export const SYNTAX_MODE_KEY = "nulldown_syntax_mode";
export { PASSKEY_PROTECTION_STORAGE_KEY };

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

export interface DropSettingsChanges {
  mode?: DropMode;
  shareVisibility?: DropVisibility;
  draftDiffPolicy?: DropDraftDiffPolicy;
  passkeyProtectionEnabled?: boolean;
  syntaxMode?: EditorSyntaxMode;
  allowedUrls?: readonly string[];
}

export interface DropSettingsSnapshot {
  mode: DropMode;
  shareVisibility: DropVisibility;
  draftDiffPolicy: DropDraftDiffPolicy;
  passkeyProtectionEnabled: boolean;
  syntaxMode: EditorSyntaxMode;
  allowedUrls: string[];
}

export type SettingName = keyof DropSettingsSnapshot;

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

export const parseLegacyUnlockPolicy = (value: string | null): DropUnlockPolicy =>
  value === "provider-escrow" ? "provider-escrow" : "vault-only";

export const parseSyncTargetProvider = (value: string | null): VoidProviderScope =>
  value === "local" ? "local" : "remote";

export const parseModeFromStoredValue = (
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

export const parseShareVisibility = (value: string | null): DropVisibility =>
  normalizeShareVisibility(value ?? "unlisted");

export const parseDraftDiffPolicy = (value: string | null): DropDraftDiffPolicy =>
  normalizeDraftDiffPolicy(value ?? "edited-only");

export const parseSyntaxMode = (value: string | null): EditorSyntaxMode =>
  normalizeSyntaxMode(value ?? "rendered");

export const parsePasskeyProtectionEnabled = (value: string | null): boolean =>
  value === null ? false : value === "1" || value === "true";

export const parseAllowedUrls = (value: string | null): string[] => {
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

export const serializeMode = (mode: DropMode) => mode;

export const serializeBoolean = (enabled: boolean) => (enabled ? "1" : "0");

export const serializeAllowedUrls = (urls: readonly string[]): string =>
  JSON.stringify(normalizeNetworkAllowlist(urls));

export const deriveSyncTargetProvider = (mode: DropMode): VoidProviderScope =>
  mode === "offline" ? "local" : "remote";

export const deriveUnlockPolicy = (
  mode: DropMode,
  visibility: DropVisibility,
): DropUnlockPolicy => {
  if (mode === "online" && visibility !== "private") {
    return "provider-escrow";
  }

  return "vault-only";
};

export const resolveCreateVisibility = (
  mode: DropMode,
  visibility: DropVisibility,
): DropVisibility => {
  if (mode === "offline") {
    return "private";
  }

  return visibility;
};

export const createSettingsObject = (
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

export const normalizeSettingsSnapshot = (
  snapshot: DropSettingsSnapshot,
): DropSettingsSnapshot => ({
  mode: snapshot.mode === "offline" ? "offline" : "online",
  shareVisibility: normalizeShareVisibility(snapshot.shareVisibility),
  draftDiffPolicy: normalizeDraftDiffPolicy(snapshot.draftDiffPolicy),
  passkeyProtectionEnabled: Boolean(snapshot.passkeyProtectionEnabled),
  syntaxMode: normalizeSyntaxMode(snapshot.syntaxMode),
  allowedUrls: normalizeNetworkAllowlist(snapshot.allowedUrls),
});

export const settingsSnapshotFromState = (state: {
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

export const derivedStateFromSnapshot = (snapshot: DropSettingsSnapshot) => {
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

export const SETTINGS_DESCRIPTORS: {
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

export const DEFAULT_SETTINGS_SNAPSHOT: DropSettingsSnapshot = {
  mode: "online",
  shareVisibility: "unlisted",
  draftDiffPolicy: "edited-only",
  passkeyProtectionEnabled: false,
  syntaxMode: "rendered",
  allowedUrls: [...DEFAULT_NETWORK_ALLOWLIST],
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

export const readPersistedItem = async (key: string): Promise<string | null> => {
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

export const writePersistedItem = async (key: string, value: string) => {
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

export const readPersistedValue = async <T>(key: string): Promise<T | null> => {
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

export const writePersistedValue = async (key: string, value: unknown) => {
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

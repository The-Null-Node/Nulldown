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
  type DropProviderScope,
} from "../lib/drop/provider";
import type { DropGraph, DropMetadata, DropPayload } from "../../shared/drop/types";

const OFFLINE_MODE_KEY = "nulldown_offline_mode";
const dropProviderRegistry = getDefaultDropProviderRegistry();

interface DropStoreState {
  offlineMode: boolean;
  hydrated: boolean;
  hydrateOfflineMode: () => Promise<void>;
  setOfflineMode: (enabled: boolean) => Promise<void>;
  createDrop: (
    payload: DropPayload,
  ) => Promise<{ id: string; url: string; scope: DropProviderScope }>;
  getDrop: (id: string) => Promise<DropPayload | null>;
  resolveDropGraph: (id: string) => Promise<DropGraph>;
  createOfflineDrop: (
    payload: DropPayload,
  ) => Promise<{ id: string; url: string }>;
  getOfflineDrop: (id: string) => Promise<DropPayload | null>;
}

const serializeOfflineMode = (enabled: boolean) => (enabled ? "1" : "0");

const parseOfflineMode = (value: string | null) =>
  value === "1" || value === "true";

const readOfflineModeFromLocalStorage = () => {
  if (typeof window === "undefined") return false;
  try {
    return parseOfflineMode(window.localStorage.getItem(OFFLINE_MODE_KEY));
  } catch {
    return false;
  }
};

const useDropStore = create<DropStoreState>((set, get) => ({
  offlineMode: false,
  hydrated: false,

  hydrateOfflineMode: async () => {
    if (get().hydrated) return;

    let offlineMode = false;

    if (isIndexedDbSupported()) {
      try {
        const stored = await getKvItem(OFFLINE_MODE_KEY);
        if (stored !== null) {
          offlineMode = parseOfflineMode(stored);
          set({ offlineMode, hydrated: true });
          return;
        }
      } catch (error) {
        console.error("Failed to hydrate offline mode from IndexedDB:", error);
      }
    }

    offlineMode = readOfflineModeFromLocalStorage();

    if (isIndexedDbSupported()) {
      try {
        await setKvItem(OFFLINE_MODE_KEY, serializeOfflineMode(offlineMode));
      } catch (error) {
        console.error("Failed to persist offline mode to IndexedDB:", error);
      }
    }

    set({ offlineMode, hydrated: true });
  },

  setOfflineMode: async (enabled: boolean) => {
    set({ offlineMode: enabled, hydrated: true });

    const serialized = serializeOfflineMode(enabled);

    if (isIndexedDbSupported()) {
      try {
        await setKvItem(OFFLINE_MODE_KEY, serialized);
        return;
      } catch (error) {
        console.error("Failed to save offline mode to IndexedDB:", error);
      }
    }

    if (typeof window === "undefined") {
      return;
    }

    try {
      window.localStorage.setItem(OFFLINE_MODE_KEY, serialized);
    } catch (error) {
      console.error("Failed to save offline mode to localStorage:", error);
    }
  },

  createDrop: async (payload: DropPayload) => {
    await get().hydrateOfflineMode();
    const provider = get().offlineMode
      ? dropProviderRegistry.local
      : dropProviderRegistry.remote;
    return provider.create(payload);
  },

  getDrop: async (id: string) => {
    const provider = dropProviderRegistry.forDropId(id);
    return provider.get(id);
  },

  resolveDropGraph: async (id: string) => {
    const provider = dropProviderRegistry.forDropId(id);
    return provider.resolveGraph(id);
  },

  createOfflineDrop: async (payload: DropPayload) => {
    const result = await dropProviderRegistry.local.create(payload);
    return {
      id: result.id,
      url: result.url,
    };
  },

  getOfflineDrop: async (id: string) => {
    if (!isOfflineDropId(id)) {
      return null;
    }

    return dropProviderRegistry.local.get(id);
  },
}));

export type { DropGraph, DropMetadata, DropPayload };
export { isOfflineDropId, OFFLINE_DROP_PREFIX };

export default useDropStore;

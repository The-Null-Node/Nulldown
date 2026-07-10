import { create, type StateCreator } from "zustand";
import type {
  DropRuntimeCompareResult,
  DropRuntimeProviderScope,
  DropRuntimeVersionRef,
} from "../../shared/drop/runtime";
import { compareDropRuntimeVersions } from "../lib/dropRuntime/providerRuntime";

/** Cache key for one provider-scoped branch version. */
export interface ProviderRuntimeVersionKey {
  provider: DropRuntimeProviderScope;
  rootDropId: string;
  branchId: string;
}

/** Store entry for one provider-scoped branch version. */
export interface ProviderRuntimeVersionEntry extends ProviderRuntimeVersionKey {
  version: DropRuntimeVersionRef;
  updatedAt: number;
}

/** State for cached local/remote provider runtime versions. */
export interface ProviderRuntimeState {
  versions: Record<string, ProviderRuntimeVersionEntry>;
  setVersion: (
    key: ProviderRuntimeVersionKey,
    version: DropRuntimeVersionRef,
    updatedAt?: number,
  ) => void;
  getVersion: (key: ProviderRuntimeVersionKey) => DropRuntimeVersionRef | null;
  clearVersion: (key: ProviderRuntimeVersionKey) => void;
  clearAll: () => void;
  compareCachedVersions: (input: {
    rootDropId: string;
    branchId: string;
  }) => DropRuntimeCompareResult;
}

/** Builds the stable cache key used for provider runtime version refs. */
export const providerRuntimeVersionCacheKey = ({
  provider,
  rootDropId,
  branchId,
}: ProviderRuntimeVersionKey): string => `${provider}:${rootDropId}:${branchId}`;

/** Creates the provider runtime cache store. Exported for isolated tests. */
export const createProviderRuntimeStore: StateCreator<ProviderRuntimeState> = (
  set,
  get,
) => ({
  versions: {},

  setVersion: (key, version, updatedAt = Date.now()) =>
    set((state) => ({
      versions: {
        ...state.versions,
        [providerRuntimeVersionCacheKey(key)]: {
          ...key,
          version,
          updatedAt,
        },
      },
    })),

  getVersion: (key) =>
    get().versions[providerRuntimeVersionCacheKey(key)]?.version ?? null,

  clearVersion: (key) =>
    set((state) => {
      const nextVersions = { ...state.versions };
      delete nextVersions[providerRuntimeVersionCacheKey(key)];
      return { versions: nextVersions };
    }),

  clearAll: () => set({ versions: {} }),

  compareCachedVersions: ({ rootDropId, branchId }) =>
    compareDropRuntimeVersions(
      get().getVersion({ provider: "local", rootDropId, branchId }),
      get().getVersion({ provider: "remote", rootDropId, branchId }),
    ),
});

const useProviderRuntimeStore = create<ProviderRuntimeState>(
  createProviderRuntimeStore,
);

export default useProviderRuntimeStore;

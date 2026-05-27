import {
  createBrowserVoidCrypto,
  type VoidCrypto,
} from "../crypto/browserVoidCrypto";
import { DefaultVoidProvider } from "./defaultVoidProvider";
import {
  LineageVoidGraph,
  OFFLINE_DROP_GRAPH_CACHE_PREFIX,
  REMOTE_DROP_GRAPH_CACHE_PREFIX,
} from "./graph";
import { HttpVoidStorage } from "../storage/httpVoidStorage";
import { IndexedDbVoidStorage } from "../storage/indexedDbVoidStorage";
import type { VoidProvider, VoidProviderRegistry } from "./types";
import { isOfflineDropId } from "./url";

class DefaultVoidProviderRegistry implements VoidProviderRegistry {
  constructor(
    readonly local: VoidProvider,
    readonly remote: VoidProvider,
  ) {}

  forDropId(id: string): VoidProvider {
    return isOfflineDropId(id) ? this.local : this.remote;
  }
}

/** Options for constructing the local void provider. */
export interface CreateLocalVoidProviderOptions {
  crypto?: VoidCrypto;
}

/** Creates the local void provider backed by IndexedDB sealed storage. */
export const createLocalVoidProvider = (
  options: CreateLocalVoidProviderOptions = {},
): VoidProvider => {
  const crypto = options.crypto ?? createBrowserVoidCrypto();

  return new DefaultVoidProvider(
    new IndexedDbVoidStorage(),
    crypto,
    new LineageVoidGraph(OFFLINE_DROP_GRAPH_CACHE_PREFIX),
  );
};

/** Options for constructing the remote void provider. */
export interface CreateRemoteVoidProviderOptions {
  crypto?: VoidCrypto;
}

/** Creates the remote void provider backed by HTTP sealed storage. */
export const createRemoteVoidProvider = (
  options: CreateRemoteVoidProviderOptions = {},
): VoidProvider => {
  const crypto = options.crypto ?? createBrowserVoidCrypto();
  return new DefaultVoidProvider(
    new HttpVoidStorage(),
    crypto,
    new LineageVoidGraph(REMOTE_DROP_GRAPH_CACHE_PREFIX),
  );
};

/** Options for constructing a void provider registry. */
export interface CreateVoidProviderRegistryOptions {
  crypto?: VoidCrypto;
}

/** Creates a registry that routes drop ids to local or remote void providers. */
export const createVoidProviderRegistry = (
  options: CreateVoidProviderRegistryOptions = {},
): VoidProviderRegistry => {
  const crypto = options.crypto ?? createBrowserVoidCrypto();
  const local = createLocalVoidProvider({ crypto });
  const remote = createRemoteVoidProvider({ crypto });
  return new DefaultVoidProviderRegistry(local, remote);
};

let defaultRegistry: VoidProviderRegistry | null = null;

/** Returns the process-wide default void provider registry. */
export const getDefaultVoidProviderRegistry = (): VoidProviderRegistry => {
  if (!defaultRegistry) {
    defaultRegistry = createVoidProviderRegistry();
  }

  return defaultRegistry;
};

/** Selects the default void provider for a drop id. */
export const getVoidProviderForDropId = (id: string): VoidProvider =>
  getDefaultVoidProviderRegistry().forDropId(id);

export const localVoidProvider = getDefaultVoidProviderRegistry().local;
export const remoteVoidProvider = getDefaultVoidProviderRegistry().remote;

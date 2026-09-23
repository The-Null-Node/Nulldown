import {
  createBrowserDropCrypto,
  type DropCrypto,
} from "../../crypto/browser-drop-crypto";
import { DefaultDropProviderPort } from "./default-drop-provider-port";
import {
  LineageDropGraphResolver,
  OFFLINE_DROP_GRAPH_CACHE_PREFIX,
  REMOTE_DROP_GRAPH_CACHE_PREFIX,
} from "./graph";
import { HttpDropStorage } from "../storage/http-storage";
import { IndexedDbDropStorage } from "../storage/indexed-db-storage";
import type { DropProviderPort, DropProviderPortRegistry } from "./types";
import { isOfflineDropId } from "./url";

class DefaultDropProviderPortRegistry implements DropProviderPortRegistry {
  constructor(
    readonly local: DropProviderPort,
    readonly remote: DropProviderPort,
  ) {}

  forDropId(id: string): DropProviderPort {
    return isOfflineDropId(id) ? this.local : this.remote;
  }
}

/** Options for constructing the local drop provider port. */
export interface CreateLocalDropProviderPortOptions {
  crypto?: DropCrypto;
}

/** Creates the local drop provider port backed by IndexedDB sealed storage. */
export const createLocalDropProviderPort = (
  options: CreateLocalDropProviderPortOptions = {},
): DropProviderPort => {
  const crypto = options.crypto ?? createBrowserDropCrypto();

  return new DefaultDropProviderPort(
    new IndexedDbDropStorage(),
    crypto,
    new LineageDropGraphResolver(OFFLINE_DROP_GRAPH_CACHE_PREFIX),
  );
};

/** Options for constructing the remote drop provider port. */
export interface CreateRemoteDropProviderPortOptions {
  crypto?: DropCrypto;
}

/** Creates the remote drop provider port backed by HTTP sealed storage. */
export const createRemoteDropProviderPort = (
  options: CreateRemoteDropProviderPortOptions = {},
): DropProviderPort => {
  const crypto = options.crypto ?? createBrowserDropCrypto();
  return new DefaultDropProviderPort(
    new HttpDropStorage(),
    crypto,
    new LineageDropGraphResolver(REMOTE_DROP_GRAPH_CACHE_PREFIX),
  );
};

/** Options for constructing a drop provider port registry. */
export interface CreateDropProviderPortRegistryOptions {
  crypto?: DropCrypto;
}

/** Creates a registry that routes drop ids to local or remote provider ports. */
export const createDropProviderPortRegistry = (
  options: CreateDropProviderPortRegistryOptions = {},
): DropProviderPortRegistry => {
  const crypto = options.crypto ?? createBrowserDropCrypto();
  const local = createLocalDropProviderPort({ crypto });
  const remote = createRemoteDropProviderPort({ crypto });
  return new DefaultDropProviderPortRegistry(local, remote);
};

let defaultRegistry: DropProviderPortRegistry | null = null;

/** Returns the process-wide default drop provider port registry. */
export const getDefaultDropProviderPortRegistry =
  (): DropProviderPortRegistry => {
    if (!defaultRegistry) {
      defaultRegistry = createDropProviderPortRegistry();
    }

    return defaultRegistry;
  };

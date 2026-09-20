/*
Drop provider ports are the browser boundary between plaintext drop operations
and sealed storage backends. Storage, crypto, and graph implementations remain
separate injected capabilities.
*/

export type {
  DropCrud,
  DropCrudContext,
  DropCrudCreateOptions,
  DropCrudRecord,
  DropProviderCreateOptions,
  DropProviderPort,
  DropProviderPortRegistry,
  DropProviderPortScope,
  DropProviderSyncOptions,
  DropProviderSyncProgress,
  DropProviderSyncResult,
  DropGraphResolver,
  DropStorage,
  DropStorageCreateOptions,
} from "./provider/types";
export {
  DropProviderHttpError,
  isDropProviderHttpError,
} from "./provider/errors";
export {
  OFFLINE_DROP_PREFIX,
  buildDropUrl,
  isOfflineDropId,
} from "./provider/url";
export {
  createDropProviderPortRegistry,
  createLocalDropProviderPort,
  createRemoteDropProviderPort,
  getDefaultDropProviderPortRegistry,
  type CreateDropProviderPortRegistryOptions,
  type CreateLocalDropProviderPortOptions,
  type CreateRemoteDropProviderPortOptions,
} from "./provider/registry";

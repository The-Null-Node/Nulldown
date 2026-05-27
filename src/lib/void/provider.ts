/*
The void provider is the app-facing boundary between plaintext drop payloads and
sealed storage backends. The implementation is split by concern under
`void/provider/*`, `void/storage/*`, and `void/crypto/*`; this file is the
stable public import path for the runtime.
*/

export type {
  Crud,
  DropCrud,
  DropCrudContext,
  DropCrudCreateOptions,
  DropCrudRecord,
  DropProviderPort,
  VoidCreateOptions,
  VoidGraph,
  VoidProvider,
  VoidProviderRegistry,
  VoidProviderScope,
  VoidStorage,
  VoidStorageCreateOptions,
  VoidSyncOptions,
  VoidSyncProgress,
  VoidSyncResult,
} from "./provider/types";
export {
  VoidProviderHttpError,
  isVoidProviderHttpError,
} from "./provider/errors";
export {
  OFFLINE_DROP_PREFIX,
  buildDropUrl,
  isOfflineDropId,
} from "./provider/url";
export {
  createLocalVoidProvider,
  createRemoteVoidProvider,
  createVoidProviderRegistry,
  getDefaultVoidProviderRegistry,
  getVoidProviderForDropId,
  localVoidProvider,
  remoteVoidProvider,
  type CreateLocalVoidProviderOptions,
  type CreateRemoteVoidProviderOptions,
  type CreateVoidProviderRegistryOptions,
} from "./provider/registry";

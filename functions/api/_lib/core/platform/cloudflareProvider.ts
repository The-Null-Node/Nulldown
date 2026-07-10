import type { VoidProvider } from "../../../../../src/server/provider";
import {
  createCloudflareBackendRuntime,
  type CloudflareVoidProviderBindings,
} from "./cloudflareBackendRuntime";

export type { CloudflareVoidProviderBindings } from "./cloudflareBackendRuntime";

/** Flushes any buffered Cloudflare branch commits before an explicit query read. */
export const repairCloudflareBranchCommitBufferForQuery = async (
  bindings: CloudflareVoidProviderBindings,
  rootDropId: string,
  branchId: string,
): Promise<void> =>
  createCloudflareBackendRuntime(bindings).repairBufferedCommitsForQuery({
    rootDropId,
    branchId,
  });

/** Creates the Cloudflare-backed VoidProvider facade for Pages routes. */
export const createCloudflareVoidProvider = (
  bindings: CloudflareVoidProviderBindings,
): VoidProvider => createCloudflareBackendRuntime(bindings).voidProvider;

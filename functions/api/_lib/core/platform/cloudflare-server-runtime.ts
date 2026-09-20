import type { NulldownServerRuntime } from "../../../../../src/server/runtime";
import {
  createCloudflareBackendRuntime,
  type CloudflareBackendRuntimeBindings,
} from "./cloudflare-backend-runtime";

export type { CloudflareBackendRuntimeBindings } from "./cloudflare-backend-runtime";

/** Flushes any buffered Cloudflare branch commits before an explicit query read. */
export const repairCloudflareBranchCommitBufferForQuery = async (
  bindings: CloudflareBackendRuntimeBindings,
  rootDropId: string,
  branchId: string,
): Promise<void> =>
  createCloudflareBackendRuntime(bindings).repairBufferedCommitsForQuery({
    rootDropId,
    branchId,
  });

/** Creates the Cloudflare-backed NulldownServerRuntime for Pages routes. */
export const createCloudflareNulldownServerRuntime = (
  bindings: CloudflareBackendRuntimeBindings,
): NulldownServerRuntime =>
  createCloudflareBackendRuntime(bindings).serverRuntime;

import type { NulldownServerRuntime } from "../../../../../../../src/server/runtime";
import {
  createInMemoryBranchCommitBuffer,
  flushBranchCommitBufferSnapshotters,
} from "../../../../../../../src/server/nulledit";
import type { RuntimeDataStore } from "../../../../../../../src/server/ports";
import { appendEventsToBranch } from "../../../../nulledit/service";
import {
  createCloudflareBlobStore,
  createCloudflareSqlStore,
} from "../storage";
import type {
  CloudflareBackendRuntimeBindings,
  CloudflareBufferedCommitRepairTarget,
} from "./contracts";
import {
  getCloudflareSnapshotterYieldNext,
  listCloudflareSnapshotters,
  registerCloudflareSnapshotter,
} from "./snapshotters";

const branchCommitBuffer = createInMemoryBranchCommitBuffer();

/** Creates Nulledit operations backed by Cloudflare storage bindings. */
export const createCloudflareNulleditRuntime = (
  bindings: CloudflareBackendRuntimeBindings,
  data: RuntimeDataStore,
  memory: NulldownServerRuntime["memory"],
): NulldownServerRuntime["nulledit"] => {
  const blobs = createCloudflareBlobStore(bindings.R2_BUCKET);
  const sql = createCloudflareSqlStore(bindings.DB);

  return {
    registerSnapshotter: registerCloudflareSnapshotter,
    yieldNext: getCloudflareSnapshotterYieldNext,
    appendDiffEvents: ({ branch, events, ...options }) => {
      const registeredSnapshotters = listCloudflareSnapshotters(
        bindings,
        data,
        memory,
      );
      return appendEventsToBranch(
        blobs,
        branch,
        events,
        {
          ...options,
          data,
          snapshotters: [
            ...registeredSnapshotters,
            ...(options.snapshotters ?? []),
          ],
          commitBuffer:
            sql && registeredSnapshotters.length
              ? branchCommitBuffer
              : undefined,
        },
        sql,
      );
    },
  };
};

/** Flushes buffered snapshotter work before an explicit branch read. */
export const repairCloudflareBufferedCommitsForQuery = async (
  bindings: CloudflareBackendRuntimeBindings,
  data: RuntimeDataStore,
  memory: NulldownServerRuntime["memory"],
  { rootDropId, branchId }: CloudflareBufferedCommitRepairTarget,
): Promise<void> => {
  if (!bindings.DB) return;

  await flushBranchCommitBufferSnapshotters({
    commitBuffer: branchCommitBuffer,
    data,
    rootDropId,
    branchId,
    reason: "explicit-query",
    snapshotters: listCloudflareSnapshotters(bindings, data, memory),
  });
};

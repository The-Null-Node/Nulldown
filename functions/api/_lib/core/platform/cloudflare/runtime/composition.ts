import {
  createNulldownServerRuntime,
  type NulldownServerRuntime,
} from "../../../../../../../src/server/runtime";
import { createNullMemService } from "../../../../nullmem/service";
import { createCloudflareRuntimePolicy } from "../../../../nullplug/policy";
import { createCloudflareNullplugRuntime } from "../../../../nullplug/runtime";
import { createCloudflareRuntimeDataStore } from "../runtime-data/store";
import {
  createCloudflareBlobStore,
  createCloudflareSqlStore,
} from "../storage";
import type {
  CloudflareBackendRuntime,
  CloudflareBackendRuntimeBindings,
} from "./contracts";
import {
  createCloudflareNulleditRuntime,
  repairCloudflareBufferedCommitsForQuery,
} from "./nulledit";
import { getCloudflareSnapshotterYieldNext } from "./snapshotters";
import { unobserved, type Timing } from "../../../observability/profiling";
import { BranchStateError } from "../../../../../../../shared/drop/branch-state";
import type { RuntimeDataStore } from "../../../../../../../src/server/ports";

export type {
  CloudflareBackendRuntime,
  CloudflareBackendRuntimeBindings,
  CloudflareBufferedCommitRepairTarget,
} from "./contracts";

const unsupported = async (): Promise<never> => {
  throw new BranchStateError("capability_unsupported");
};

/** Creates the composed Cloudflare backend runtime for Pages route adapters. */
export const createCloudflareBackendRuntime = (
  bindings: CloudflareBackendRuntimeBindings,
  timing: Timing = unobserved,
): CloudflareBackendRuntime => {
  const local = bindings.localBranchApplication;
  if (local && local.mode !== "local-test") {
    throw new BranchStateError("capability_unsupported");
  }
  const data: RuntimeDataStore = local
    ? (local.data ?? {
        get: unsupported,
        put: unsupported,
        putMany: unsupported,
        delete: unsupported,
        list: unsupported,
        query: unsupported,
        tx: unsupported,
        lock: unsupported,
      })
    : createCloudflareRuntimeDataStore(bindings);
  const memory: NulldownServerRuntime["memory"] = local
    ? {
        query: unsupported,
        createFact: unsupported,
        createProcedure: unsupported,
        delete: unsupported,
      }
    : createNullMemService({
        blobs: createCloudflareBlobStore(bindings.R2_BUCKET),
        sql: createCloudflareSqlStore(bindings.DB),
        data,
      });
  const nulledit = createCloudflareNulleditRuntime(
    bindings,
    data,
    memory,
    timing,
  );
  const policy: NulldownServerRuntime["policy"] = local
    ? { prepare: unsupported, validate: unsupported }
    : createCloudflareRuntimePolicy({
        bindings,
        trustedPluginIds: ["nd"],
        preauthorizedCallerRootDropId: bindings.nullplugCallerRootDropId,
      });
  const nullplug: NulldownServerRuntime["nullplug"] = local
    ? { supports: unsupported, invoke: unsupported }
    : createCloudflareNullplugRuntime(bindings, policy);
  let serverRuntime: NulldownServerRuntime | null = null;

  return {
    data,
    memory,
    nulledit,
    nullplug,
    policy,
    get serverRuntime() {
      serverRuntime ??= createNulldownServerRuntime({
        data,
        nulledit,
        memory,
        nullplug,
        policy,
      });
      return serverRuntime;
    },
    repairBufferedCommitsForQuery: (target) =>
      repairCloudflareBufferedCommitsForQuery(bindings, data, memory, target),
    getSnapshotterYieldNext: bindings.localBranchApplication
      ? nulledit.yieldNext
      : getCloudflareSnapshotterYieldNext,
  };
};

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

export type {
  CloudflareBackendRuntime,
  CloudflareBackendRuntimeBindings,
  CloudflareBufferedCommitRepairTarget,
} from "./contracts";

/** Creates the composed Cloudflare backend runtime for Pages route adapters. */
export const createCloudflareBackendRuntime = (
  bindings: CloudflareBackendRuntimeBindings,
): CloudflareBackendRuntime => {
  const data = createCloudflareRuntimeDataStore(bindings);
  const blobs = createCloudflareBlobStore(bindings.R2_BUCKET);
  const sql = createCloudflareSqlStore(bindings.DB);
  const memory = createNullMemService({ blobs, sql, data });
  const nulledit = createCloudflareNulleditRuntime(bindings, data, memory);
  const policy = createCloudflareRuntimePolicy({
    bindings,
    trustedPluginIds: ["nd"],
    preauthorizedCallerRootDropId: bindings.nullplugCallerRootDropId,
  });
  const nullplug = createCloudflareNullplugRuntime(bindings, policy);
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
    getSnapshotterYieldNext: getCloudflareSnapshotterYieldNext,
  };
};

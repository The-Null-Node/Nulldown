import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import {
  createVoidProvider,
  type VoidProvider,
} from "../../../../../src/server/provider";
import { createBuiltInNulleditSnapshotters } from "../../../../../src/server/nulledit";
import { appendEventsToBranch } from "../../nulledit/service";
import { createCloudflareVoidDataStore } from "./cloudflarePorts";

/** Cloudflare bindings required to compose the app-facing VoidProvider. */
export interface CloudflareVoidProviderBindings {
  R2_BUCKET: R2Bucket;
  DB?: D1Database;
}

/** Creates the Cloudflare-backed VoidProvider facade for Pages routes. */
export const createCloudflareVoidProvider = (
  bindings: CloudflareVoidProviderBindings,
): VoidProvider => {
  const data = createCloudflareVoidDataStore(bindings);
  const builtInSnapshotters = bindings.DB ? createBuiltInNulleditSnapshotters() : [];

  return createVoidProvider({
    data,
    nulledit: {
      appendDiffEvents: ({ branch, events, ...options }) =>
        appendEventsToBranch(
          bindings.R2_BUCKET,
          branch,
          events,
          {
            ...options,
            data,
            snapshotters: [
              ...builtInSnapshotters,
              ...(options.snapshotters ?? []),
            ],
          },
          bindings.DB,
        ),
    },
  });
};

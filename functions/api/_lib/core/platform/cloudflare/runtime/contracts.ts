import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { NulldownServerRuntime } from "../../../../../../../src/server/runtime";
import type {
  NulleditNextRequest,
  NulleditNextResult,
} from "../../../../../../../src/server/nulledit/types";
import type { RuntimeDataStore } from "../../../../../../../src/server/ports";
import type { AccountAuthRequest } from "../../../../accounts/session/authentication";

/** Cloudflare bindings required to compose the server runtime. */
export interface CloudflareBackendRuntimeBindings {
  /** R2 bucket for canonical branch and drop records. */
  R2_BUCKET: R2Bucket;
  /** Optional D1 database for queryable metadata and derived data. */
  DB?: D1Database;
  /** Provider escrow key used by trusted built-in nullplug resolvers. */
  PROVIDER_ENCRYPTION_PRIVATE_JWK?: string;
  /** Remote nullplug endpoint allowlist used at registration and invocation. */
  NULLPLUG_REGISTRY_ALLOWED_HOSTS?: string;
  /** Optional fetch implementation for focused runtime tests. */
  fetchImpl?: typeof fetch;
  /** Secret used to validate account bearer sessions for nullplug reads. */
  ACCOUNT_AUTH_SECRET?: string;
  /** Optional account session lifetime configuration. */
  ACCOUNT_AUTH_TOKEN_TTL_MS?: string;
  /** Explicit development-only account-header opt-in. */
  ALLOW_INSECURE_ACCOUNT_HEADER?: string;
  /** Authenticated request used for separately targeted built-in root reads. */
  nullplugReadRequest?: AccountAuthRequest;
  /** Canonical caller root already authorized by the route boundary. */
  nullplugCallerRootDropId?: string;
}

/** Branch whose buffered derived writes should be flushed before a read. */
export interface CloudflareBufferedCommitRepairTarget {
  /** Root drop id for the queried branch. */
  rootDropId: string;
  /** Branch id whose derived state should be repaired. */
  branchId: string;
}

/** Composed Cloudflare backend runtime used by route adapters. */
export interface CloudflareBackendRuntime {
  /** Cloudflare-backed functional data store. */
  data: RuntimeDataStore;
  /** Branch-scoped memory facade backed by NullMem records. */
  memory: NulldownServerRuntime["memory"];
  /** Nulledit append and snapshotter operations. */
  nulledit: NulldownServerRuntime["nulledit"];
  /** Server-runtime-owned nullplug runtime. */
  nullplug: NulldownServerRuntime["nullplug"];
  /** Server-runtime-owned policy service. */
  policy: NulldownServerRuntime["policy"];
  /** Backend server runtime, created lazily for routes that need it. */
  readonly serverRuntime: NulldownServerRuntime;
  /** Flushes buffered derived writes before explicit resolved-query reads. */
  repairBufferedCommitsForQuery(
    target: CloudflareBufferedCommitRepairTarget,
  ): Promise<void>;
  /** Ask a registered snapshotter for a compact next-step projection. */
  getSnapshotterYieldNext(
    id: string,
    request?: NulleditNextRequest,
  ): NulleditNextResult | Promise<NulleditNextResult> | undefined;
}

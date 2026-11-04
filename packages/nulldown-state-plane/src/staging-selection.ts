import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import {
  createCloudflareBlobStore,
  createCloudflareSqlStore,
} from "../../../functions/api/_lib/core/platform/cloudflare/storage";
import { BranchStateError } from "../../../shared/drop/branch-state";
import { createLocalBranchLifecycle } from "../../../src/server/state-plane/application-lifecycle";
import type { LocalBranchApplicationSelection } from "../../../src/server/state-plane/commit-application";
import {
  RpcBranchCommitStatePlane,
  type BranchStateRpcStub,
} from "./shard-router";

/** Narrow deployment dependencies consumed by one isolated staging request. */
export interface StagingSelectionDependencies {
  ENVIRONMENT: string;
  R2_BUCKET: R2Bucket;
  DB: D1Database;
  STATE_PLANE: BranchStateRpcStub;
  PROVIDER_ENCRYPTION_PRIVATE_JWK: string;
}

/**
 * Composes one request over the private service binding and dedicated staging root stores.
 * This deployment must be the sole writer of fresh roots in those stores. Admission
 * still verifies ownership, immutable escrow source and absence of legacy history.
 * No fixture initialization, runtime-data fallback or background snapshotters are installed.
 */
export function createStagingBranchApplication(
  bindings: StagingSelectionDependencies,
): LocalBranchApplicationSelection {
  if (
    bindings.ENVIRONMENT !== "staging" ||
    !bindings.R2_BUCKET ||
    !bindings.DB ||
    !bindings.STATE_PLANE ||
    !bindings.PROVIDER_ENCRYPTION_PRIVATE_JWK
  ) {
    throw new BranchStateError("state_unavailable");
  }
  const sql = createCloudflareSqlStore(bindings.DB);
  if (!sql) throw new BranchStateError("state_unavailable");
  // The service owns shard routing. Reuse the validated RPC client, resolving
  // every shard to that same private service rather than exposing DO bindings.
  const backend = new RpcBranchCommitStatePlane(() => bindings.STATE_PLANE);
  const placement = { routingVersion: 1, generation: 1 };
  return {
    mode: "hosted-staging",
    commits: backend,
    placement,
    lifecycle: createLocalBranchLifecycle({
      mode: "hosted-staging",
      blobs: createCloudflareBlobStore(bindings.R2_BUCKET),
      sql,
      providerPrivateKey: bindings.PROVIDER_ENCRYPTION_PRIVATE_JWK,
      backend,
      isEligibleRoot: () => true,
      initialPlacement: placement,
    }),
    history: backend,
    runtimeFacts: backend,
    nullmem: { backend },
  };
}

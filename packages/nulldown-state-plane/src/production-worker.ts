/// <reference path="../production-configuration.d.ts" />
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  executeProductionMigration,
  type ProductionMigrationCommand,
} from "./production-control";
import { branchStateRpcResult } from "./shard-router";

export { BranchStateObject, BranchStateService, default } from "./worker";

/** Private control entrypoint, bound only by operator tooling; Pages receives the application entrypoint. */
export class BranchMigrationService extends WorkerEntrypoint<ProductionStatePlaneEnv> {
  /** Executes one exact-enrollment operation; durable state determines retry and transfer semantics. */
  async execute(command: ProductionMigrationCommand) {
    return branchStateRpcResult(() =>
      executeProductionMigration(
        this.env,
        (name) =>
          this.env.BRANCH_STATE.get(this.env.BRANCH_STATE.idFromName(name)),
        command,
      ),
    );
  }
}

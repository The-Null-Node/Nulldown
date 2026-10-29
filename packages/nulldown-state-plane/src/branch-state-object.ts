import { DurableObject } from "cloudflare:workers";
import {
  BranchStateError,
  BranchStateQuery,
  type BranchAppendRecord,
  type BranchContentQuery,
  type BranchEventRangeQuery,
  type BranchHeadQuery,
} from "../../../shared/drop/branch-state";
import { SqliteBranchCommitStatePlane } from "../../../src/server/state-plane/sqlite-commits";
import {
  synchronousSqlResult,
  type BranchSqlPort,
  type BranchSqlValue,
} from "../../../src/server/state-plane/sqlite-port";
import type { MemoryBranchStateSeed } from "../../../src/server/state-plane/memory-commits";
import {
  branchStateRpcResult,
  branchStateShardName,
  type BranchStateRpcResult,
} from "./shard-router";

/** Internal binding dependency derived from Wrangler's generated configuration contract. */
export type BranchStateBindings = Pick<
  Env,
  "BRANCH_STATE" | "STATE_PLANE_LOCAL_TEST"
>;

/** Adapts one SQLite DO storage lifetime to the synchronous portable SQL port. */
export class DurableObjectBranchSqlite implements BranchSqlPort {
  constructor(private readonly storage: DurableObjectStorage) {}
  /** Materializes SQL rows before the owning synchronous transaction exits. */
  rows<T extends Record<string, unknown>>(
    sql: string,
    ...bindings: BranchSqlValue[]
  ): T[] {
    return this.storage.sql.exec(sql, ...bindings).toArray() as T[];
  }
  /** Executes SQL without awaiting; exceptions remain inside transactionSync. */
  execute(sql: string, ...bindings: BranchSqlValue[]): void {
    this.storage.sql.exec(sql, ...bindings);
  }
  /** Rolls back all SQL mutations if any synchronous publication step throws. */
  transaction<T>(body: () => T): T {
    return this.storage.transactionSync(() => synchronousSqlResult(body()));
  }
}

/** Internal fixed-pool branch authority; SQL survives eviction, exact-content cache does not. */
export class BranchStateObject extends DurableObject<BranchStateBindings> {
  readonly #plane: SqliteBranchCommitStatePlane;

  constructor(ctx: DurableObjectState, env: BranchStateBindings) {
    super(ctx, env);
    this.#plane = new SqliteBranchCommitStatePlane(
      new DurableObjectBranchSqlite(ctx.storage),
    );
  }

  async #placement(query: BranchHeadQuery): Promise<void> {
    const name = await branchStateShardName(query);
    if (!this.ctx.id.equals(this.env.BRANCH_STATE.idFromName(name))) {
      throw new BranchStateError("routing_generation_mismatch");
    }
  }

  /** Typed append RPC; receiver rejects direct stubs targeting the wrong deterministic shard. */
  async append(input: BranchAppendRecord) {
    return branchStateRpcResult(async () => {
      const command = structuredClone(input);
      await this.#placement(
        BranchStateQuery.head({
          target: command?.target,
          placement: command?.placement,
        }),
      );
      return this.#plane.append(command);
    });
  }
  /** Read-only head RPC with explicit result envelope. */
  async readHead(input: BranchHeadQuery) {
    return branchStateRpcResult(async () => {
      const query = BranchStateQuery.head(input);
      await this.#placement(query);
      return this.#plane.readHead(query);
    });
  }
  /** Read-only exact-version content RPC with durable generation checks on cache hits. */
  async readContent(input: BranchContentQuery) {
    return branchStateRpcResult(async () => {
      const query = BranchStateQuery.content(input);
      await this.#placement({
        target: query.target,
        placement: query.placement,
      });
      return this.#plane.readContent(query);
    });
  }
  /** Read-only contiguous event range RPC. */
  async readEvents(
    input: BranchEventRangeQuery,
  ): Promise<BranchStateRpcResult<unknown[]>> {
    return branchStateRpcResult(async () => {
      const query = BranchStateQuery.range(input);
      await this.#placement({
        target: query.target,
        placement: query.placement,
      });
      return this.#plane.readEvents(query);
    });
  }
  /** Fixture-only initializer; requires an explicit local-test binding and never replaces existing branches. */
  async seedLocalFixtures(input: readonly MemoryBranchStateSeed[]) {
    return branchStateRpcResult(async () => {
      if (this.env.STATE_PLANE_LOCAL_TEST !== "1")
        throw new BranchStateError("capability_unsupported");
      if (!Array.isArray(input)) throw new BranchStateError("invalid_command");
      const seeds = structuredClone(input);
      for (const seed of seeds) {
        const query = BranchStateQuery.head({
          target: {
            rootDropId: seed?.branch?.rootDropId,
            branchId: seed?.branch?.branchId,
          },
          placement: seed?.placement,
        });
        await this.#placement(query);
      }
      await this.#plane.seed(seeds);
      return { seeded: seeds.length };
    });
  }
  /** No unauthenticated HTTP state surface. Authorization remains at the existing application route boundary. */
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  }
}

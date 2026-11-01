// Native workerd fixture entrypoint, bundled only by scripts/state-plane/native-contracts.ts.
// Test controls are confined to this subclass; production Worker/API paths never import it.
import {
  BranchStateObject,
  DurableObjectBranchSqlite,
  type BranchStateBindings,
} from "../src/branch-state-object";
import {
  branchStateRpcResult,
  branchStateShardName,
} from "../src/shard-router";
import { SqliteBranchCommitStatePlane } from "../../../src/server/state-plane/sqlite-commits";
import { ExactContentCache } from "../../../src/server/state-plane/exact-content-cache";
import type {
  BranchSqlPort,
  BranchSqlValue,
} from "../../../src/server/state-plane/sqlite-port";
import {
  BranchStateError,
  type BranchAppendRecord,
  type BranchHeadQuery,
  type BranchEventRangeQuery,
  type BranchContentQuery,
  type BranchStateVersion,
} from "../../../shared/drop/branch-state";
import type { BranchInitializeRecord } from "../../../shared/drop/branch-lifecycle";
import type { BranchRuntimeFactAppendCommand } from "../../../shared/drop/branch-runtime-facts";
import { observeBranchSql } from "../../../src/server/state-plane/sqlite-port";

interface Trace {
  operation: string;
  phase: string;
  sql?: string;
  transaction?: number;
}

/** Actual native subclass retaining production RPC behavior and native SQLite. */
export class TestBranchStateObject extends BranchStateObject {
  private readonly bootId = crypto.randomUUID();
  private readonly counters: { r2: number };
  private lastTrace: Trace[] = [];
  constructor(ctx: DurableObjectState, env: BranchStateBindings) {
    const counters = { r2: 0 };
    const trap = Object.fromEntries(
      ["get", "put", "head", "list", "delete"].map((method) => [
        method,
        () => {
          counters.r2++;
          throw Error(`R2_FORBIDDEN_${method}`);
        },
      ]),
    );
    super(ctx, { ...env, ...{ R2_BUCKET: trap, BUCKET: trap, R2: trap } });
    this.counters = counters;
  }
  private fixture(): void {
    if (this.env.STATE_PLANE_LOCAL_TEST !== "1")
      throw new BranchStateError("capability_unsupported");
  }

  /** Native fact publication cutpoints; all four runtime tables share the production SQLite transaction. */
  async runtimeFactCutFixture(
    command: BranchRuntimeFactAppendCommand,
    cut: number | null = null,
    loseResponse = false,
  ) {
    this.fixture();
    let armed = false,
      index = 0,
      fired = false;
    const trace: Trace[] = [];
    const port = observeBranchSql(
      new DurableObjectBranchSqlite(this.ctx.storage),
      (row) => {
        if (!armed) return;
        trace.push(row);
        if (row.operation !== "transaction" && index++ === cut) {
          fired = true;
          throw Error("FIXTURE_RUNTIME_FACT_CUT");
        }
      },
    );
    const plane = new SqliteBranchCommitStatePlane(port);
    armed = true;
    const result = await branchStateRpcResult(async () => {
      const accepted = await plane.appendRuntimeFact(command);
      await this.ctx.storage.sync();
      if (loseResponse) throw Error("FIXTURE_RUNTIME_FACT_RESPONSE_LOST");
      return accepted;
    });
    this.lastTrace = trace;
    return { result, trace, fired };
  }

  /** Reads actual runtime-fact rows for native rollback, restart and outbox acceptance assertions. */
  async inspectRuntimeFactsFixture(query: BranchHeadQuery) {
    this.fixture();
    const scope = [
      JSON.stringify(query.target.rootDropId),
      JSON.stringify(query.target.branchId),
    ];
    return {
      bootId: this.bootId,
      counts: Object.fromEntries(
        [
          "branch_runtime_facts",
          "branch_runtime_fact_receipts",
          "branch_runtime_fact_heads",
          "branch_runtime_fact_outbox",
        ].map((table) => [
          table,
          this.ctx.storage.sql
            .exec<{ n: number }>(
              `SELECT COUNT(*) AS n FROM ${table} WHERE root_drop_id=? AND branch_id=?`,
              ...scope,
            )
            .one().n,
        ]),
      ),
      outbox: this.ctx.storage.sql
        .exec<{ outbox_json: string }>(
          "SELECT outbox_json FROM branch_runtime_fact_outbox WHERE root_drop_id=? AND branch_id=? ORDER BY identity",
          ...scope,
        )
        .toArray()
        .map((row) => JSON.parse(row.outbox_json)),
      trace: this.lastTrace,
    };
  }

  /** Native transaction cutpoints for activation; an interrupted attempt retains its durable pending reservation. */
  async initializeCutFixture(
    command: BranchInitializeRecord,
    cut: number | null = null,
    loseResponse = false,
  ) {
    this.fixture();
    let armed = false,
      index = 0,
      fired = false;
    const trace: Trace[] = [];
    const port = observeBranchSql(
      new DurableObjectBranchSqlite(this.ctx.storage),
      (row) => {
        if (!armed) return;
        trace.push(row);
        if (row.operation !== "transaction" && index++ === cut) {
          fired = true;
          throw Error("FIXTURE_INITIALIZATION_CUT");
        }
      },
    );
    const plane = new SqliteBranchCommitStatePlane(port);
    armed = true;
    const result = await branchStateRpcResult(async () => {
      const initialized = await plane.initialize(command);
      await this.ctx.storage.sync();
      if (loseResponse) throw Error("FIXTURE_INITIALIZATION_RESPONSE_LOST");
      return initialized;
    });
    this.lastTrace = trace;
    return { result, trace, fired };
  }

  /** Reads durable rows directly; boot identity distinguishes real instance reset. */
  async inspectFixture(query: BranchHeadQuery) {
    this.fixture();
    const scope = [
      JSON.stringify(query.target.rootDropId),
      JSON.stringify(query.target.branchId),
    ];
    return {
      bootId: this.bootId,
      r2Calls: this.counters.r2,
      outbox: this.ctx.storage.sql
        .exec<{ outbox_json: string }>(
          "SELECT outbox_json FROM branch_outbox WHERE root_drop_id=? AND branch_id=? ORDER BY event_id",
          ...scope,
        )
        .toArray()
        .map((row) => JSON.parse(row.outbox_json)),
      counts: Object.fromEntries(
        [
          "branch_heads",
          "branch_snapshots",
          "branch_events",
          "branch_receipts",
          "branch_outbox",
        ].map((table) => [
          table,
          this.ctx.storage.sql
            .exec<{ n: number }>(
              `SELECT COUNT(*) AS n FROM ${table} WHERE root_drop_id=? AND branch_id=?`,
              ...scope,
            )
            .one().n,
        ]),
      ),
      trace: this.lastTrace,
    };
  }

  /** Synchronous cutpoints exercise the same backend and real storage.transactionSync, not a JS map. */
  async appendCutFixture(
    command: BranchAppendRecord,
    cut: number | null = null,
    loseResponse = false,
  ) {
    this.fixture();
    let armed = false,
      index = 0,
      fired = false,
      transactions = 0,
      depth = 0;
    const raw = new DurableObjectBranchSqlite(this.ctx.storage),
      trace: Trace[] = [];
    const observe = (e: Trace) => {
      if (!armed) return;
      trace.push(e);
      if (e.operation !== "transaction" && index++ === cut) {
        fired = true;
        throw Error("FIXTURE_SQL_CUT");
      }
    };
    const port: BranchSqlPort = {
      rows<T extends Record<string, unknown>>(
        sql: string,
        ...bindings: BranchSqlValue[]
      ): T[] {
        observe({
          operation: "rows",
          phase: "before",
          sql,
          transaction: transactions,
        });
        const value = raw.rows<T>(sql, ...bindings);
        observe({
          operation: "rows",
          phase: "after",
          sql,
          transaction: transactions,
        });
        return value;
      },
      execute(sql, ...bindings) {
        observe({
          operation: "execute",
          phase: "before",
          sql,
          transaction: transactions,
        });
        raw.execute(sql, ...bindings);
        observe({
          operation: "execute",
          phase: "after",
          sql,
          transaction: transactions,
        });
      },
      transaction<T>(body: () => T): T {
        transactions++;
        observe({
          operation: "transaction",
          phase: "before",
          transaction: transactions,
        });
        const result = raw.transaction(() => {
          depth++;
          try {
            return body();
          } finally {
            depth--;
          }
        });
        observe({
          operation: "transaction",
          phase: "after",
          transaction: transactions,
        });
        return result;
      },
    };
    const plane = new SqliteBranchCommitStatePlane(port, {
      cache: new ExactContentCache({ maxEntries: 2, maxBytes: 4096 }),
    });
    transactions = 0;
    armed = true;
    const result = await branchStateRpcResult(async () => {
      const accepted = await plane.append(command);
      if (depth !== 0) throw Error("ASYNC_TRANSACTION_LEAK");
      await this.ctx.storage.sync();
      if (loseResponse)
        throw Error("FIXTURE_RESPONSE_LOST_AFTER_DURABLE_COMMIT");
      return accepted;
    });
    this.lastTrace = trace;
    return { result, trace, fired };
  }

  /** Deliberately damages only synthetic rows to verify fail-closed native readers. */
  async corruptRangeFixture(query: BranchHeadQuery, seq: number) {
    this.fixture();
    this.ctx.storage.sql.exec(
      "DELETE FROM branch_events WHERE root_drop_id=? AND branch_id=? AND event_seq=?",
      JSON.stringify(query.target.rootDropId),
      JSON.stringify(query.target.branchId),
      seq,
    );
    return true;
  }

  /** Measures actual native SQL reads and the native query planner with disposable bounded L1. */
  async readProbeFixture(query: BranchEventRangeQuery) {
    this.fixture();
    const raw = new DurableObjectBranchSqlite(this.ctx.storage);
    let trace: { sql: string; rowsRead: number; rowsWritten: number }[] = [];
    const port: BranchSqlPort = {
      rows: <T extends Record<string, unknown>>(
        sql: string,
        ...bindings: BranchSqlValue[]
      ): T[] => {
        const cursor = this.ctx.storage.sql.exec(sql, ...bindings);
        const result = cursor.toArray() as T[];
        trace.push({
          sql,
          rowsRead: cursor.rowsRead,
          rowsWritten: cursor.rowsWritten,
        });
        return result;
      },
      execute: (sql, ...bindings) => raw.execute(sql, ...bindings),
      transaction: (body) => raw.transaction(body),
    };
    const cache = new ExactContentCache({ maxEntries: 2, maxBytes: 4096 });
    const plane = new SqliteBranchCommitStatePlane(port, { cache });
    const headQuery = { target: query.target, placement: query.placement };
    const contentQuery = { ...headQuery, version: query.version };
    trace = [];
    await plane.readHead(headQuery);
    const head = trace;
    trace = [];
    await plane.readContent(contentQuery);
    const cold = trace;
    trace = [];
    await plane.readContent(contentQuery);
    const hot = trace;
    trace = [];
    await plane.readEvents(query);
    const range = trace;
    const eventQuery = range.find((row) =>
      row.sql.includes("FROM branch_events"),
    );
    if (!eventQuery) throw Error("missing bounded event query");
    const plan = this.ctx.storage.sql
      .exec(
        "EXPLAIN QUERY PLAN " + eventQuery.sql,
        JSON.stringify(query.target.rootDropId),
        JSON.stringify(query.target.branchId),
        query.startSeq,
        query.endSeq,
      )
      .toArray();
    return {
      head,
      cold,
      hot,
      range,
      plan,
      cache: cache.stats(),
      r2Calls: this.counters.r2,
    };
  }

  /** Cold/warm/evicted native reads and literal SQL cells, with independent fixture encoding. */
  async losslessProbeFixture(input: {
    query: BranchHeadQuery;
    versions: BranchStateVersion[];
  }) {
    this.fixture();
    const { query, versions } = input;
    const cache = new ExactContentCache({ maxEntries: 1, maxBytes: 16_384 });
    const plane = new SqliteBranchCommitStatePlane(
      new DurableObjectBranchSqlite(this.ctx.storage),
      { cache },
    );
    const reads: { snapshotId: number; stage: string; content: string }[] = [];
    for (const version of versions) {
      for (const stage of ["cold", "warm"])
        reads.push({
          snapshotId: version.snapshotId,
          stage,
          content: (await plane.readContent({ ...query, version })).content,
        });
    }
    const zero = { ...query, version: versions[0] };
    const evicted = cache.get(zero) === undefined;
    reads.push({
      snapshotId: versions[0].snapshotId,
      stage: "evicted",
      content: (await plane.readContent(zero)).content,
    });
    const scope = [
      JSON.stringify(query.target.rootDropId),
      JSON.stringify(query.target.branchId),
    ];
    const snapshots = this.ctx.storage.sql
      .exec(
        "SELECT root_drop_id, branch_id, snapshot_id, content FROM branch_snapshots WHERE root_drop_id=? AND branch_id=? ORDER BY snapshot_id",
        ...scope,
      )
      .toArray();
    const identities = Object.fromEntries(
      ["branch_events", "branch_receipts", "branch_outbox"].map((table) => [
        table,
        this.ctx.storage.sql
          .exec(
            `SELECT event_id FROM ${table} WHERE root_drop_id=? AND branch_id=? ORDER BY event_id`,
            ...scope,
          )
          .toArray(),
      ]),
    );
    return { reads, evicted, snapshots, identities, r2Calls: this.counters.r2 };
  }

  /** Raw corruption deliberately accepts already-encoded cells to distinguish decode from hash failures. */
  async corruptContentFixture(input: {
    query: BranchContentQuery;
    encoded: string;
  }) {
    this.fixture();
    this.ctx.storage.sql.exec(
      "UPDATE branch_snapshots SET content=? WHERE root_drop_id=? AND branch_id=? AND snapshot_id=?",
      input.encoded,
      JSON.stringify(input.query.target.rootDropId),
      JSON.stringify(input.query.target.branchId),
      input.query.version.snapshotId,
    );
    return branchStateRpcResult(() =>
      new SqliteBranchCommitStatePlane(
        new DurableObjectBranchSqlite(this.ctx.storage),
      ).readContent(input.query),
    );
  }

  /** A real runtime reset retaining SQLite; never substitutes new Class(backedMap). */
  async resetFixture() {
    this.fixture();
    await this.ctx.storage.sync();
    this.ctx.abort("fixture native reset");
  }
}

export default {
  async fetch(request: Request, env: BranchStateBindings) {
    const q = (await request.json()) as {
      action: string;
      query: BranchHeadQuery;
      value?: unknown;
      cut?: number | null;
      shard?: string;
      loseResponse?: boolean;
    };
    try {
      const name = q.shard ?? (await branchStateShardName(q.query));
      const stub = env.BRANCH_STATE.get(
        env.BRANCH_STATE.idFromName(name),
      ) as unknown as {
        readPlacement(value: unknown): Promise<unknown>;
        reserve(value: unknown): Promise<unknown>;
        initialize(value: unknown): Promise<unknown>;
        readSnapshot(value: unknown): Promise<unknown>;
        listSnapshots(value: unknown): Promise<unknown>;
        initializeCutFixture(
          command: unknown,
          cut: number | null,
          loseResponse: boolean,
        ): Promise<unknown>;
        seedLocalFixtures(value: unknown): Promise<unknown>;
        append(value: unknown): Promise<unknown>;
        readHead(value: unknown): Promise<unknown>;
        readContent(value: unknown): Promise<unknown>;
        readEvents(value: unknown): Promise<unknown>;
        appendRuntimeFact(value: unknown): Promise<unknown>;
        readRuntimeFactHead(value: unknown): Promise<unknown>;
        readRuntimeFacts(value: unknown): Promise<unknown>;
        runtimeFactCutFixture(
          command: unknown,
          cut: number | null,
          loseResponse: boolean,
        ): Promise<unknown>;
        inspectRuntimeFactsFixture(query: BranchHeadQuery): Promise<unknown>;
        inspectFixture(query: BranchHeadQuery): Promise<unknown>;
        appendCutFixture(
          command: unknown,
          cut: number | null,
          loseResponse: boolean,
        ): Promise<unknown>;
        corruptRangeFixture(
          query: BranchHeadQuery,
          seq: number,
        ): Promise<unknown>;
        resetFixture(): Promise<void>;
        readProbeFixture(query: unknown): Promise<unknown>;
        losslessProbeFixture(input: unknown): Promise<unknown>;
        corruptContentFixture(input: unknown): Promise<unknown>;
      };
      let result: unknown;
      switch (q.action) {
        case "runtime-fact-append":
          result = await stub.appendRuntimeFact(q.value);
          break;
        case "runtime-fact-head":
          result = await stub.readRuntimeFactHead(q.value ?? q.query);
          break;
        case "runtime-facts":
          result = await stub.readRuntimeFacts(q.value);
          break;
        case "runtime-fact-cut":
          result = await stub.runtimeFactCutFixture(
            q.value,
            q.cut ?? null,
            q.loseResponse ?? false,
          );
          break;
        case "runtime-fact-inspect":
          result = await stub.inspectRuntimeFactsFixture(q.query);
          break;
        case "placement":
          result = await stub.readPlacement(
            q.value ?? { target: q.query.target },
          );
          break;
        case "reserve":
          result = await stub.reserve(q.value);
          break;
        case "initialize":
          result = await stub.initialize(q.value);
          break;
        case "snapshot":
          result = await stub.readSnapshot(q.value);
          break;
        case "snapshots":
          result = await stub.listSnapshots(q.value);
          break;
        case "initialize-cut":
          result = await stub.initializeCutFixture(
            q.value,
            q.cut ?? null,
            q.loseResponse ?? false,
          );
          break;
        case "seed":
          result = await stub.seedLocalFixtures(q.value);
          break;
        case "append":
          result = await stub.append(q.value);
          break;
        case "head":
          result = await stub.readHead(q.value ?? q.query);
          break;
        case "content":
          result = await stub.readContent(q.value);
          break;
        case "events":
          result = await stub.readEvents(q.value);
          break;
        case "inspect":
          result = await stub.inspectFixture(q.query);
          break;
        case "cut":
          result = await stub.appendCutFixture(
            q.value,
            q.cut ?? null,
            q.loseResponse ?? false,
          );
          break;
        case "corrupt":
          result = await stub.corruptRangeFixture(q.query, Number(q.value));
          break;
        case "reset":
          await stub.resetFixture();
          result = { unexpected: true };
          break;
        case "probe":
          result = await stub.readProbeFixture(q.value);
          break;
        case "lossless-probe":
          result = await stub.losslessProbeFixture(q.value);
          break;
        case "corrupt-content":
          result = await stub.corruptContentFixture(q.value);
          break;
        default:
          return new Response(null, { status: 404 });
      }
      return Response.json(result);
    } catch (error) {
      return Response.json(
        error instanceof BranchStateError
          ? { ok: false, error: error.toRecord() }
          : {
              fixtureError:
                error instanceof Error ? error.message : String(error),
            },
      );
    }
  },
};

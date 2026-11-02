import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  realpathSync,
  readdirSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { resolve, relative } from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import type { BuildOptions, BuildResult } from "esbuild";
import type * as MiniflareModule from "miniflare";
import type {
  Miniflare as NativeMiniflare,
  V4MiniflareOptions,
} from "miniflare";
import type {
  BranchAppendOutcome,
  BranchCommitOutboxRecord,
  BranchCommitStatePlane,
  BranchHeadQuery,
} from "../../shared/drop/branch-state";
import type {
  BranchRuntimeFactAppendCommand,
  BranchRuntimeFactAppendResult,
  BranchRuntimeFactOutbox,
  BranchRuntimeFactStatePlane,
} from "../../shared/drop/branch-runtime-facts";
import {
  assertRecords,
  commitContractScenarios,
  contractHistory,
  contractSeed,
  initialQuery,
  rejectsCode,
  assertUtf16,
  losslessFixtures,
  verifyLosslessHistory,
  referenceVersion,
  referenceSourceHash,
} from "../../src/server/state-plane/testing/commit-contract";
import { runShardRouterContract } from "../../packages/nulldown-state-plane/test/shard-router.test";
import { runNativeLifecycleContract } from "../../packages/nulldown-state-plane/test/lifecycle-native.test";
import { runNativeNullMemContract } from "../../packages/nulldown-state-plane/test/nullmem-native.test";
import type {
  BranchNullMemPutCommand,
  BranchNullMemQueryResult,
} from "../../shared/drop/branch-nullmem";

const argument = (name: string) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const root = resolve(argument("root") ?? process.cwd());
const evidenceArgument = argument("evidence");
if (!evidenceArgument)
  throw Error("Explicit --evidence= owned output directory is required");
const evidence = resolve(evidenceArgument),
  require = createRequire(resolve(root, "package.json"));
const runtimeRequire = createRequire(
  resolve(root, "node_modules/wrangler/package.json"),
);
const hash = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const compatibilityDate = "2026-08-26";
const deadlines = {
  requestMs: 30_000,
  scenarioMs: 180_000,
  source: "premeasurement native smoke policy, not production SLO",
  hotR2Calls: 0,
  sqlReads: { head: 2, cold: 6, hot: 4, range: 3 },
};

function networkGuard() {
  const net = require("node:net") as {
    Socket: { prototype: { connect: (...args: unknown[]) => unknown } };
    _normalizeArgs: (args: unknown[]) => [{ path?: string; host?: string }];
  };
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args: unknown[]) {
    const options = net._normalizeArgs(args)[0];
    if (
      !options.path &&
      !["localhost", "127.0.0.1", "::1", "[::1]"].includes(
        options.host ?? "localhost",
      )
    )
      throw Error("HOST_NETWORK_DISABLED");
    return connect.apply(this, args);
  };
  const fetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname))
        throw Error("HOST_NETWORK_DISABLED");
      return fetch(input, init);
    },
    {
      preconnect: () => {
        throw Error("HOST_NETWORK_DISABLED");
      },
    },
  );
}

interface Command {
  action: string;
  query?: BranchHeadQuery;
  value?: unknown;
  cut?: number | null;
  shard?: string;
  loseResponse?: boolean;
  locked?: boolean;
}
interface Inspection {
  bootId: string;
  r2Calls: number;
  outbox: BranchCommitOutboxRecord[];
  counts: Record<string, number>;
  trace: { operation: string; phase: string; sql?: string }[];
}
interface RuntimeFactInspection {
  bootId: string;
  counts: Record<string, number>;
  outbox: BranchRuntimeFactOutbox[];
  trace: Inspection["trace"];
}
interface Wire {
  ok?: boolean;
  value?: unknown;
  error?: { code: string; status: number; outcome: string; retry: string };
  fixtureError?: string;
}

function unwrap<T>(record: unknown): T {
  const wire = record as Wire;
  assert.ok(
    wire && typeof wire === "object" && !wire.fixtureError,
    wire?.fixtureError ?? "Malformed native fixture result",
  );
  if (wire.ok === false) {
    assert.ok(wire.error);
    throw Object.assign(new Error(wire.error.code), wire.error);
  }
  assert.equal(wire.ok, true, JSON.stringify(wire));
  return wire.value as T;
}

async function child() {
  networkGuard();
  const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } =
    runtimeRequire("miniflare") as typeof MiniflareModule;
  let externalRequests = 0;
  const options: V4MiniflareOptions = {
    rootPath: root,
    modulesRoot: evidence,
    resourceTmpPath: resolve(evidence, `tmp-${process.pid}`),
    resourcePersistencePath: resolve(evidence, "native-state"),
    host: "127.0.0.1",
    port: 0,
    cf: false,
    telemetry: { enabled: false },
    log: new Log(LogLevel.NONE),
    workers: ["fixture", "locked"].map((name) => ({
      name,
      modules: [
        {
          type: "ESModule" as const,
          path: resolve(evidence, "native-worker.mjs"),
        },
      ],
      modulesRoot: evidence,
      compatibilityDate,
      bindings: { STATE_PLANE_LOCAL_TEST: name === "fixture" ? "1" : "0" },
      durableObjects: {
        BRANCH_STATE: {
          className: "TestBranchStateObject",
          useSQLite: true,
          unsafeUniqueKey: `wave1-${name}-v1`,
        },
      },
      outboundService: () => {
        externalRequests++;
        throw Error("WORKER_NETWORK_DISABLED");
      },
    })),
  };
  const mf: NativeMiniflare = new Miniflare(convertV4MiniflareOptions(options));
  const workers = {
    fixture: await mf.getWorker("fixture"),
    locked: await mf.getWorker("locked"),
  };
  process.stdout.write(
    JSON.stringify({ ready: true, pid: process.pid }) + "\n",
  );
  const pending = new Set<Promise<void>>();
  try {
    for await (const line of createInterface({ input: process.stdin })) {
      const { id, command } = JSON.parse(line) as {
        id: number;
        command: Command;
      };
      if (command.action === "close") {
        await Promise.all(pending);
        await mf.dispose();
        process.stdout.write(
          JSON.stringify({
            id,
            result: { closed: true, externalRequests, pid: process.pid },
          }) + "\n",
        );
        return;
      }
      const task = (async () => {
        try {
          const worker = command.locked ? workers.locked : workers.fixture;
          const response = await worker.fetch(
            "https://fixture.invalid/command",
            { method: "POST", body: JSON.stringify(command) },
          );
          process.stdout.write(
            JSON.stringify({ id, result: await response.json() }) + "\n",
          );
        } catch (error) {
          process.stdout.write(
            JSON.stringify({ id, error: String(error) }) + "\n",
          );
        }
      })();
      pending.add(task);
      void task.finally(() => pending.delete(task));
    }
  } finally {
    await Promise.all(pending);
    await mf.dispose();
  }
}

class NativeProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private serial = 0;
  readonly ready: Promise<number>;
  constructor() {
    this.child = spawn(
      process.execPath,
      [process.argv[1], `--root=${root}`, `--evidence=${evidence}`, "--child"],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: resolve(evidence, "empty-home"),
          TMPDIR: resolve(evidence, "temp"),
          CI: "true",
          WRANGLER_SEND_METRICS: "false",
          WRANGLER_WRITE_LOGS: "false",
          STATE_PLANE_LOCAL_TEST: "0",
        },
        stdio: "pipe",
      },
    );
    this.child.stderr.on("data", (chunk) =>
      appendFileSync(resolve(evidence, "native-stderr.log"), chunk),
    );
    let readyResolve!: (pid: number) => void,
      readyReject!: (error: Error) => void;
    this.ready = new Promise((yes, no) => {
      readyResolve = yes;
      readyReject = no;
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const message = JSON.parse(line) as {
        ready?: boolean;
        pid: number;
        id: number;
        result: unknown;
        error?: string;
      };
      if (message.ready) {
        readyResolve(message.pid);
        return;
      }
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.pending.delete(message.id);
      if (message.error) waiter.reject(Error(message.error));
      else waiter.resolve(message.result);
    });
    this.child.on("exit", (code) => {
      const error = Error(`Native process exited ${code}`);
      readyReject(error);
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      this.pending.clear();
    });
  }
  async call(command: Command): Promise<unknown> {
    await this.ready;
    const id = ++this.serial,
      start = performance.now();
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error("Predeclared native request deadline exceeded"));
      }, deadlines.requestMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.child.stdin.write(JSON.stringify({ id, command }) + "\n");
    const result = await promise;
    appendFileSync(
      resolve(evidence, "native-trace.ndjson"),
      JSON.stringify({
        pid: this.child.pid,
        id,
        command,
        result,
        ms: performance.now() - start,
      }) + "\n",
    );
    return result;
  }
  async close() {
    const exit = once(this.child, "exit");
    const result = (await this.call({ action: "close" })) as {
      externalRequests: number;
    };
    assert.equal(result.externalRequests, 0);
    await exit;
  }
}

async function main() {
  networkGuard();
  for (const path of [
    evidence,
    resolve(evidence, "empty-home"),
    resolve(evidence, "temp"),
  ])
    mkdirSync(path, { recursive: true });
  const esbuild = require("esbuild") as {
    build: (options: BuildOptions) => Promise<BuildResult>;
  };
  const build = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [
      "packages/nulldown-state-plane/test/branch-state-object.test.ts",
    ],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:workers"],
    outfile: resolve(evidence, "native-worker.mjs"),
    metafile: true,
  });
  const inputs = Object.keys(build.metafile!.inputs).map((path) => {
    const absolute = realpathSync(resolve(root, path));
    assert.ok(
      absolute.startsWith(realpathSync(root) + "/"),
      `mixed source tree: ${absolute}`,
    );
    return { path, realpath: absolute, sha256: hash(readFileSync(absolute)) };
  });
  const pins = {
    root: realpathSync(root),
    node: process.version,
    compatibilityDate,
    dependencies: ["miniflare", "workerd", "wrangler"].map((name) => {
      const path = runtimeRequire.resolve(name + "/package.json");
      return {
        name,
        realpath: realpathSync(path),
        version: JSON.parse(readFileSync(path, "utf8")).version,
        sha256: hash(readFileSync(path)),
      };
    }),
    esbuild: require("esbuild/package.json").version,
    lockSha256: hash(readFileSync(resolve(root, "bun.lock"))),
    inputs,
    bundleSha256: hash(readFileSync(resolve(evidence, "native-worker.mjs"))),
  };
  const lossless = losslessFixtures();
  writeFileSync(
    resolve(evidence, "native-premeasurement.json"),
    JSON.stringify(
      {
        pins,
        deadlines,
        histories: [contractHistory(100), contractHistory(100, 0x28c0a103)],
        lossless,
      },
      null,
      2,
    ),
  );
  writeFileSync(resolve(evidence, "native-trace.ndjson"), "");
  const results: {
    name: string;
    ms: number;
    passed: boolean;
    error?: string;
  }[] = [];
  let client = new NativeProcess(),
    serial = 0;
  const run = async (name: string, body: () => Promise<void>) => {
    const start = performance.now();
    try {
      await body();
      assert.ok(performance.now() - start < deadlines.scenarioMs);
      results.push({ name, ms: performance.now() - start, passed: true });
      console.log("PASS", name);
    } catch (error) {
      results.push({
        name,
        ms: performance.now() - start,
        passed: false,
        error: String(error),
      });
      console.error("FAIL", name, error);
    }
  };
  const seed = async () => {
    const fixture = contractSeed(`native-${++serial}`),
      query = initialQuery(fixture);
    unwrap(await client.call({ action: "seed", query, value: [fixture] }));
    return { fixture, query };
  };
  const remap = (
    query: BranchHeadQuery,
    command: ReturnType<typeof contractHistory>[number]["command"],
  ) => ({ ...command, target: query.target });
  const route = (query: BranchHeadQuery, input: BranchHeadQuery) => ({
    placement: input.placement,
    target: input.target.branchId === "owner" ? query.target : input.target,
  });
  const plane = (query: BranchHeadQuery): BranchCommitStatePlane => ({
    append: async (command) =>
      unwrap(
        await client.call({
          action: "append",
          query: route(query, command),
          value: { ...command, target: route(query, command).target },
        }),
      ),
    readHead: async (q) =>
      unwrap(
        await client.call({
          action: "head",
          query: route(query, q),
          value: { ...q, target: route(query, q).target },
        }),
      ),
    readContent: async (q) =>
      unwrap(
        await client.call({
          action: "content",
          query: route(query, q),
          value: { ...q, target: route(query, q).target },
        }),
      ),
    readEvents: async (q) =>
      unwrap(
        await client.call({
          action: "events",
          query: route(query, q),
          value: { ...q, target: route(query, q).target },
        }),
      ),
  });
  const runtime = (query: BranchHeadQuery): BranchRuntimeFactStatePlane => ({
    appendRuntimeFact: async (value) =>
      unwrap(
        await client.call({ action: "runtime-fact-append", query, value }),
      ),
    readRuntimeFactHead: async (value) =>
      unwrap(await client.call({ action: "runtime-fact-head", query, value })),
    readRuntimeFacts: async (value) =>
      unwrap(await client.call({ action: "runtime-facts", query, value })),
  });
  const runtimeCommand = (
    query: BranchHeadQuery,
    id = "native-fact",
    sourceContentHash = referenceSourceHash(""),
  ): BranchRuntimeFactAppendCommand => ({
    ...query,
    actorAccountId: "fixture-owner",
    fact: {
      version: 1,
      kind: "ui.state.patch",
      id,
      callId: "native-call",
      createdAt: 1,
      source: { ...query.target, sourceContentHash },
      patch: [{ op: "set", path: ["value"], value: "\ud800" }],
      metadata: { actorAccountId: "untrusted-client" },
    },
  });
  const runtimeTables = [
    "branch_runtime_facts",
    "branch_runtime_fact_receipts",
    "branch_runtime_fact_heads",
    "branch_runtime_fact_outbox",
  ];
  const runtimeCounts = (facts: number) =>
    Object.fromEntries(
      runtimeTables.map((table) => [
        table,
        table === "branch_runtime_fact_heads" ? Number(facts > 0) : facts,
      ]),
    );
  const inspectRuntime = async (query: BranchHeadQuery) =>
    (await client.call({
      action: "runtime-fact-inspect",
      query,
    })) as RuntimeFactInspection;
  const inspectLossless = async (fixture: (typeof lossless)[number]) => {
    const { query, history } = fixture;
    const contents = [
      fixture.seed.content,
      ...history.map((row) => row.content),
    ];
    const measured = (await client.call({
      action: "lossless-probe",
      query,
      value: {
        query,
        versions: contents.map((content, snapshotId) =>
          referenceVersion(snapshotId, content),
        ),
      },
    })) as {
      reads: { snapshotId: number; stage: string; content: string }[];
      snapshots: unknown[];
      identities: Record<string, { event_id: string }[]>;
      evicted: boolean;
      r2Calls: number;
    };
    assert.equal(
      measured.evicted,
      true,
      "one-entry native LRU really evicted snapshot zero",
    );
    assert.equal(measured.r2Calls, 0);
    assertRecords(measured.reads, [
      ...contents.flatMap((content, snapshotId) =>
        ["cold", "warm"].map((stage) => ({ snapshotId, stage, content })),
      ),
      { snapshotId: 0, stage: "evicted", content: fixture.seed.content },
    ]);
    for (const read of measured.reads)
      assertUtf16(read.content, contents[read.snapshotId]);
    assertRecords(
      measured.snapshots,
      contents.map((content, snapshotId) => ({
        root_drop_id: JSON.stringify(query.target.rootDropId),
        branch_id: JSON.stringify(query.target.branchId),
        snapshot_id: snapshotId,
        content: JSON.stringify(content),
      })),
    );
    const ids = history
      .map((row) => JSON.stringify(row.command.event.eventId))
      .sort()
      .map((event_id) => ({ event_id }));
    for (const table of ["branch_events", "branch_receipts", "branch_outbox"])
      assertRecords(measured.identities[table], ids);
    const durable = (await client.call({
      action: "inspect",
      query,
    })) as Inspection;
    assert.equal(durable.r2Calls, 0);
    assertRecords(durable.counts, {
      branch_heads: 1,
      branch_snapshots: 6,
      branch_events: 5,
      branch_receipts: 5,
      branch_outbox: 5,
    });
    assertRecords(
      durable.outbox
        .map((row) => row.receipt)
        .sort((a, b) => a.version.snapshotId - b.version.snapshotId),
      history.map((row) => row.receipt),
    );
    for (const row of durable.outbox)
      assert.equal(
        row.id,
        JSON.stringify([
          "branch.commit.v1",
          query.target.rootDropId,
          query.target.branchId,
          row.receipt.eventId,
        ]),
      );
    return durable;
  };
  try {
    await client.ready;
    await run("independent frozen shard vectors and RPC errors", async () => {
      await runShardRouterContract();
    });
    await run(
      "native lifecycle RPC fields, activation cutpoints and pending/receipt recovery",
      async () => {
        await runNativeLifecycleContract((command) => client.call(command));
      },
    );
    // Each generic scenario has isolated branch state. Adapt target only at transport, restore it in returned wire values.
    await run(
      "native mutable NullMem RPC, UTF-16, concurrent writes, reset, lost acknowledgement and atomic rollback",
      async () => {
        const proof = await runNativeNullMemContract(
          (command) => client.call(command),
          seed,
        );
        writeFileSync(
          resolve(evidence, "native-nullmem.json"),
          JSON.stringify(proof, null, 2),
        );
      },
    );
    for (const scenario of commitContractScenarios)
      await run("native " + scenario.name, async () => {
        const { query } = await seed();
        const actual = plane(query);
        const restore = <T>(value: T): T =>
          JSON.parse(
            JSON.stringify(value).replaceAll(
              JSON.stringify(query.target.branchId),
              JSON.stringify("owner"),
            ),
          ) as T;
        const adapter: BranchCommitStatePlane = {
          append: async (c) => restore(await actual.append(c)),
          readHead: async (q) => restore(await actual.readHead(q)),
          readContent: async (q) => restore(await actual.readContent(q)),
          readEvents: (q) => actual.readEvents(q),
        };
        await scenario.run({
          plane: adapter,
          inspectOutbox: async () => {
            const inspected = (await client.call({
              action: "inspect",
              query,
            })) as Inspection;
            assert.equal(inspected.r2Calls, 0);
            return inspected.outbox.map((row) => {
              assert.equal(
                row.id,
                JSON.stringify([
                  "branch.commit.v1",
                  query.target.rootDropId,
                  query.target.branchId,
                  row.receipt.eventId,
                ]),
              );
              assertRecords(row.receipt.target, query.target);
              return {
                ...restore(row),
                id: JSON.stringify([
                  "branch.commit.v1",
                  query.target.rootDropId,
                  "owner",
                  row.receipt.eventId,
                ]),
              };
            });
          },
          close: async () => {},
        });
      });
    await run(
      "default test flag rejects seed; wrong direct shard rejects; no implicit init",
      async () => {
        const q = initialQuery();
        await rejectsCode(
          async () =>
            unwrap(
              await client.call({
                action: "seed",
                query: q,
                value: [contractSeed()],
                locked: true,
              }),
            ),
          "capability_unsupported",
        );
        await rejectsCode(
          async () =>
            unwrap(
              await client.call({
                action: "head",
                query: q,
                value: q,
                shard: "branch-state-v1-11",
              }),
            ),
          "routing_placement_mismatch",
        );
        await rejectsCode(
          async () =>
            unwrap(await client.call({ action: "head", query: q, value: q })),
          "branch_not_found",
        );
      },
    );
    await run(
      "native transactionSync rollback at every statement boundary including outbox",
      async () => {
        const sample = await seed(),
          entry = contractHistory(1)[0];
        const observed = (await client.call({
          action: "cut",
          query: sample.query,
          value: remap(sample.query, entry.command),
        })) as { result: Wire; trace: Inspection["trace"] };
        unwrap(observed.result);
        const cuts = observed.trace.filter(
          (e) => e.operation !== "transaction",
        );
        assert.ok(cuts.some((e) => e.sql?.includes("branch_outbox")));
        for (let cut = 0; cut < cuts.length; cut++) {
          const { query } = await seed(),
            command = remap(query, entry.command);
          const failed = (await client.call({
            action: "cut",
            query,
            value: command,
            cut,
          })) as { result: Wire; fired: boolean };
          assert.equal(failed.fired, true);
          assertRecords(failed.result, {
            ok: false,
            error: {
              code: "state_unavailable",
              status: 503,
              outcome: "unknown",
              retry: "same-command",
            },
          });
          const stats = (await client.call({
            action: "inspect",
            query,
          })) as Inspection;
          assertRecords(stats.counts, {
            branch_heads: 1,
            branch_snapshots: 1,
            branch_events: 0,
            branch_receipts: 0,
            branch_outbox: 0,
          });
          assert.equal(stats.r2Calls, 0);
          await rejectsCode(
            async () =>
              unwrap(
                await client.call({
                  action: "content",
                  query,
                  value: { ...query, version: entry.receipt.version },
                }),
              ),
            "snapshot_not_found",
          );
          const retry = unwrap<BranchAppendOutcome>(
            await client.call({ action: "append", query, value: command }),
          );
          assert.equal(retry.status, "accepted");
          assertRecords(retry.receipt.version, entry.receipt.version);
        }
        results.push({
          name: `native synchronous cutpoints executed: ${cuts.length}`,
          ms: 0,
          passed: true,
        });
      },
    );
    await run(
      "lost response after durable commit returns stable original receipt",
      async () => {
        const { query } = await seed(),
          entry = contractHistory(1)[0],
          command = remap(query, entry.command);
        const lost = (await client.call({
          action: "cut",
          query,
          value: command,
          loseResponse: true,
        })) as { result: Wire };
        assert.equal(lost.result.error?.retry, "same-command");
        const retry = unwrap<BranchAppendOutcome>(
          await client.call({ action: "append", query, value: command }),
        );
        assertRecords(retry, {
          status: "duplicate",
          receipt: { ...entry.receipt, target: query.target },
        });
        assert.equal(
          ((await client.call({ action: "inspect", query })) as Inspection)
            .outbox.length,
          1,
        );
      },
    );
    await run(
      "native runtime facts: all three kinds, concurrent retry and duplicate after document edit",
      async () => {
        const { query } = await seed();
        const facts = runtime(query);
        const originalHead = await plane(query).readHead(query);
        const patch = runtimeCommand(query);
        const attempts = await Promise.all(
          Array.from({ length: 3 }, () => facts.appendRuntimeFact(patch)),
        );
        assert.equal(attempts.filter((result) => result.appended).length, 1);
        for (const result of attempts)
          assertRecords(result.receipt, attempts[0].receipt);
        const source = patch.fact.source;
        const snapshot = await facts.appendRuntimeFact({
          ...patch,
          fact: {
            version: 1,
            kind: "ui.state.snapshot",
            id: "native-snapshot",
            callId: "native-call",
            createdAt: 1,
            source,
            state: { value: "\ud800" },
          },
        });
        const response = await facts.appendRuntimeFact({
          ...patch,
          fact: {
            version: 1,
            kind: "ui.response",
            id: "native-response",
            primitiveId: "native-form",
            createdAt: 1,
            source,
            data: { approved: true },
          },
        });
        const expectedEvents = [attempts[0], snapshot, response].map(
          (result) => result.receipt.event,
        );
        assertRecords(
          expectedEvents.map((event) => [event.seq, event.fact.kind]),
          [
            [0, "ui.state.patch"],
            [1, "ui.state.snapshot"],
            [2, "ui.response"],
          ],
        );
        for (const event of expectedEvents) {
          assert.equal(event.fact.createdAt, event.createdAt);
          assert.equal(event.fact.source.snapshotId, 0);
          assert.equal(event.fact.metadata?.actorAccountId, "fixture-owner");
        }
        const head = await facts.readRuntimeFactHead(query);
        assertRecords(head, { ...query, headSeq: 2 });
        const page = await facts.readRuntimeFacts({
          ...head,
          afterSeq: -1,
          limit: 200,
        });
        assertRecords(page, { ...head, facts: expectedEvents, nextCursor: 2 });
        assertRecords(await plane(query).readHead(query), originalHead);
        const entry = contractHistory(1)[0];
        await plane(query).append(remap(query, entry.command));
        const retried = await facts.appendRuntimeFact({
          ...patch,
          fact: {
            ...patch.fact,
            createdAt: 999,
            source: { ...patch.fact.source, snapshotId: 999 },
          },
        });
        assertRecords(retried, { ...attempts[0], appended: false });
        await rejectsCode(
          () => facts.appendRuntimeFact(runtimeCommand(query, "stale-new")),
          "stale_source",
        );
        await rejectsCode(
          () =>
            facts.appendRuntimeFact({ ...patch, actorAccountId: "not-writer" }),
          "forbidden",
        );
        await rejectsCode(
          () =>
            facts.appendRuntimeFact({
              ...patch,
              placement: {
                ...query.placement,
                generation: query.placement.generation + 1,
              },
            }),
          "routing_generation_mismatch",
        );
        assertRecords((await inspectRuntime(query)).counts, runtimeCounts(3));
        assertRecords(
          await facts.readRuntimeFacts({ ...head, afterSeq: 2, limit: 200 }),
          { ...head, facts: [], nextCursor: null },
        );
        const stored = await inspectRuntime(query);
        assertRecords(
          stored.outbox
            .map((intent) => intent.receipt)
            .sort((a, b) => a.event.seq - b.event.seq),
          [attempts[0].receipt, snapshot.receipt, response.receipt],
        );
        assert.equal(
          ((await client.call({ action: "inspect", query })) as Inspection)
            .r2Calls,
          0,
        );
        writeFileSync(
          resolve(evidence, "native-runtime-facts.json"),
          JSON.stringify(
            { query, attempts, snapshot, response, page, stored },
            null,
            2,
          ),
        );
      },
    );
    await run(
      "native runtime fact transactionSync rollback at all four publication statements",
      async () => {
        const sample = await seed();
        const observed = (await client.call({
          action: "runtime-fact-cut",
          query: sample.query,
          value: runtimeCommand(sample.query),
        })) as { result: Wire; trace: Inspection["trace"]; fired: boolean };
        const accepted = unwrap<BranchRuntimeFactAppendResult>(observed.result);
        assert.equal(accepted.appended, true);
        const operations = observed.trace.filter(
          (event) => event.operation !== "transaction",
        );
        const cuts = operations.flatMap((event, index) =>
          event.operation === "execute" &&
          runtimeTables.some((table) =>
            event.sql?.startsWith(`INSERT INTO ${table} `),
          )
            ? [{ index, ...event }]
            : [],
        );
        assert.equal(cuts.length, 8);
        for (const table of runtimeTables)
          assertRecords(
            cuts
              .filter((event) => event.sql?.startsWith(`INSERT INTO ${table} `))
              .map((event) => event.phase),
            ["before", "after"],
          );
        const proof = [];
        for (const cut of cuts) {
          const { query } = await seed();
          const command = runtimeCommand(query);
          const failed = (await client.call({
            action: "runtime-fact-cut",
            query,
            value: command,
            cut: cut.index,
          })) as { result: Wire; fired: boolean };
          assert.equal(failed.fired, true);
          assertRecords(failed.result, {
            ok: false,
            error: {
              code: "state_unavailable",
              status: 503,
              outcome: "unknown",
              retry: "same-command",
            },
          });
          const beforeRetry = await inspectRuntime(query);
          assertRecords(beforeRetry.counts, runtimeCounts(0));
          assertRecords(beforeRetry.outbox, []);
          const branch = (await client.call({
            action: "inspect",
            query,
          })) as Inspection;
          assertRecords(branch.counts, {
            branch_heads: 1,
            branch_snapshots: 1,
            branch_events: 0,
            branch_receipts: 0,
            branch_outbox: 0,
          });
          assert.equal(branch.r2Calls, 0);
          assertRecords(await runtime(query).readRuntimeFactHead(query), {
            ...query,
            headSeq: -1,
          });
          const retry = await runtime(query).appendRuntimeFact(command);
          assert.equal(retry.appended, true);
          assert.equal(retry.receipt.event.seq, 0);
          const recovered = await inspectRuntime(query);
          assertRecords(recovered.counts, runtimeCounts(1));
          assertRecords(
            recovered.outbox.map((intent) => intent.receipt),
            [retry.receipt],
          );
          proof.push({ cut, failed, beforeRetry, retry, recovered });
        }
        writeFileSync(
          resolve(evidence, "native-runtime-fact-cutpoints.json"),
          JSON.stringify({ operations, proof }, null, 2),
        );
      },
    );
    await run(
      "native constant SQL budgets, zero R2 and indexed bounded range query",
      async () => {
        const { query } = await seed(),
          history = contractHistory(100);
        const samples: unknown[] = [];
        for (const [index, entry] of history.entries()) {
          unwrap(
            await client.call({
              action: "append",
              query,
              value: remap(query, entry.command),
            }),
          );
          if (![1, 10, 24, 25, 100].includes(index + 1)) continue;
          type Statement = {
            sql: string;
            rowsRead: number;
            rowsWritten: number;
          };
          const measured = (await client.call({
            action: "probe",
            query,
            value: {
              ...query,
              version: entry.receipt.version,
              startSeq: 0,
              endSeq: index,
            },
          })) as {
            head: Statement[];
            cold: Statement[];
            hot: Statement[];
            range: Statement[];
            plan: { detail: string }[];
            r2Calls: number;
          };
          for (const kind of ["head", "cold", "hot", "range"] as const)
            assert.ok(
              measured[kind].length <= deadlines.sqlReads[kind],
              `${kind} SQL budget`,
            );
          assert.equal(measured.r2Calls, deadlines.hotR2Calls);
          assert.equal(
            measured.range.filter((row) =>
              row.sql.includes("FROM branch_events"),
            ).length,
            1,
          );
          assert.ok(
            measured.plan.some((row) =>
              /SEARCH .*branch_events.*INDEX/i.test(row.detail),
            ),
            JSON.stringify(measured.plan),
          );
          assert.ok(
            measured.plan.every((row) => !/\bSCAN\b/i.test(row.detail)),
            JSON.stringify(measured.plan),
          );
          samples.push({ snapshot: index + 1, ...measured });
        }
        writeFileSync(
          resolve(evidence, "native-read-budgets.json"),
          JSON.stringify(samples, null, 2),
        );
      },
    );
    await run(
      "native interior range corruption is not partial success",
      async () => {
        const { query } = await seed(),
          history = contractHistory(3);
        for (const entry of history)
          unwrap(
            await client.call({
              action: "append",
              query,
              value: remap(query, entry.command),
            }),
          );
        await client.call({ action: "corrupt", query, value: 1 });
        await rejectsCode(
          async () =>
            unwrap(
              await client.call({
                action: "events",
                query,
                value: {
                  ...query,
                  version: history[2].receipt.version,
                  startSeq: 0,
                  endSeq: 2,
                },
              }),
            ),
          "state_corrupt",
        );
      },
    );
    await run(
      "S1 lossless UTF-16 seeds/half-emoji deletes and same-shard scope/event identities",
      async () => {
        for (const fixture of lossless) {
          const { query, history } = fixture;
          unwrap(
            await client.call({ action: "seed", query, value: [fixture.seed] }),
          );
          const actual = plane(query);
          for (let read = 0; read < 2; read++)
            assertUtf16(
              (
                await actual.readContent({
                  ...query,
                  version: referenceVersion(0, fixture.seed.content),
                })
              ).content,
              fixture.seed.content,
            );
          for (const row of history)
            assertRecords(await actual.append(row.command), {
              status: "accepted",
              receipt: row.receipt,
            });
        }
        const inspections: Inspection[] = [];
        for (const fixture of lossless) {
          await verifyLosslessHistory(plane(fixture.query), fixture);
          inspections.push(await inspectLossless(fixture));
        }
        // An unencoded implementation cannot evade collision coverage by hashing into distinct objects.
        for (const offset of [0, 3])
          assert.equal(
            new Set(
              inspections.slice(offset, offset + 3).map((row) => row.bootId),
            ).size,
            1,
          );
      },
    );
    await run(
      "S1 exact UTF-16 and original receipts/ranges survive native reset and process restart",
      async () => {
        const before = await Promise.all(
          lossless.map((fixture) => inspectLossless(fixture)),
        );
        for (const offset of [0, 3]) {
          const reset = (await client.call({
            action: "reset",
            query: lossless[offset].query,
          })) as Wire;
          assert.ok(reset.fixtureError);
        }
        const afterReset: Inspection[] = [];
        for (const [index, fixture] of lossless.entries()) {
          await verifyLosslessHistory(plane(fixture.query), fixture);
          const inspected = await inspectLossless(fixture);
          assert.notEqual(inspected.bootId, before[index].bootId);
          assertRecords(inspected.outbox, before[index].outbox);
          afterReset.push(inspected);
        }
        const firstPid = await client.ready;
        await client.close();
        client = new NativeProcess();
        const nextPid = await client.ready;
        assert.notEqual(firstPid, nextPid);
        const recovered: Inspection[] = [];
        for (const [index, fixture] of lossless.entries()) {
          await verifyLosslessHistory(plane(fixture.query), fixture);
          const inspected = await inspectLossless(fixture);
          assert.notEqual(inspected.bootId, afterReset[index].bootId);
          assertRecords(inspected.outbox, before[index].outbox);
          assertRecords(inspected.counts, before[index].counts);
          recovered.push(inspected);
        }
        writeFileSync(
          resolve(evidence, "lossless-restart-proof.json"),
          JSON.stringify(
            { firstPid, nextPid, before, afterReset, recovered },
            null,
            2,
          ),
        );
      },
    );
    await run(
      "S1 native content decode and valid-JSON hash corruption fail closed",
      async () => {
        const fixture = {
          ...contractSeed(`native-corruption-${++serial}`),
          content: "ok",
        };
        const query = initialQuery(fixture);
        unwrap(await client.call({ action: "seed", query, value: [fixture] }));
        for (const encoded of [
          "not-json",
          "null",
          "42",
          "{}",
          "[]",
          JSON.stringify("xx"),
        ]) {
          await rejectsCode(
            async () =>
              unwrap(
                await client.call({
                  action: "corrupt-content",
                  query,
                  value: {
                    query: {
                      ...query,
                      version: referenceVersion(0, fixture.content),
                    },
                    encoded,
                  },
                }),
              ),
            "state_corrupt",
          );
        }
      },
    );
    await run(
      "actual object reset and OS subprocess restart retain SQLite, exact versions, receipt and outbox",
      async () => {
        const { query } = await seed(),
          history = contractHistory(25);
        for (const entry of history)
          unwrap(
            await client.call({
              action: "append",
              query,
              value: remap(query, entry.command),
            }),
          );
        const factCommand = runtimeCommand(
          query,
          "restart-lost-ack",
          history[24].receipt.version.sourceContentHash,
        );
        const factLost = (await client.call({
          action: "runtime-fact-cut",
          query,
          value: factCommand,
          loseResponse: true,
        })) as { result: Wire };
        assertRecords(factLost.result, {
          ok: false,
          error: {
            code: "state_unavailable",
            status: 503,
            outcome: "unknown",
            retry: "same-command",
          },
        });
        const factsBefore = await inspectRuntime(query);
        const memoryCommand: BranchNullMemPutCommand = {
          ...query,
          actorAccountId: "fixture-owner",
          record: {
            version: 1,
            kind: "fact",
            ...query.target,
            recordId: "memory-restart-\ud800",
            text: "retained",
            createdAt: 1,
            metadata: { actorAccountId: "preserved" },
          },
        };
        unwrap(
          await client.call({
            action: "nullmem-put",
            query,
            value: memoryCommand,
          }),
        );
        const memoryBefore = unwrap<BranchNullMemQueryResult>(
          await client.call({
            action: "nullmem-query",
            query,
            value: { ...query, limit: 100 },
          }),
        );
        assertRecords(factsBefore.counts, runtimeCounts(1));
        assert.equal(factsBefore.outbox.length, 1);
        const factReceipt = factsBefore.outbox[0].receipt;
        assert.equal(factReceipt.event.fact.source.snapshotId, 25);
        assert.equal(factReceipt.event.seq, 0);
        const factHead = await runtime(query).readRuntimeFactHead(query);
        assertRecords(factHead, { ...query, headSeq: 0 });
        const factPage = {
          ...factHead,
          facts: [factReceipt.event],
          nextCursor: 0,
        };
        assertRecords(await runtime(query).appendRuntimeFact(factCommand), {
          ...query,
          appended: false,
          receipt: factReceipt,
        });
        assertRecords(
          await runtime(query).readRuntimeFacts({
            ...factHead,
            afterSeq: -1,
            limit: 200,
          }),
          factPage,
        );
        const before = (await client.call({
          action: "inspect",
          query,
        })) as Inspection;
        const reset = (await client.call({ action: "reset", query })) as Wire;
        assert.ok(reset.fixtureError);
        const afterReset = (await client.call({
          action: "inspect",
          query,
        })) as Inspection;
        assert.notEqual(afterReset.bootId, before.bootId);
        assertRecords(afterReset.outbox, before.outbox);
        const factsAfterReset = await inspectRuntime(query);
        assert.notEqual(factsAfterReset.bootId, factsBefore.bootId);
        assertRecords(factsAfterReset.counts, factsBefore.counts);
        assertRecords(factsAfterReset.outbox, factsBefore.outbox);
        assertRecords(
          unwrap(
            await client.call({
              action: "nullmem-query",
              query,
              value: { ...query, limit: 100 },
            }),
          ),
          memoryBefore,
        );
        assertRecords(await runtime(query).appendRuntimeFact(factCommand), {
          ...query,
          appended: false,
          receipt: factReceipt,
        });
        assertRecords(
          await runtime(query).readRuntimeFacts({
            ...factHead,
            afterSeq: -1,
            limit: 200,
          }),
          factPage,
        );
        const firstPid = await client.ready;
        await client.close();
        client = new NativeProcess();
        const nextPid = await client.ready;
        assert.notEqual(firstPid, nextPid);
        const recovered = (await client.call({
          action: "inspect",
          query,
        })) as Inspection;
        assert.notEqual(recovered.bootId, afterReset.bootId);
        assertRecords(recovered.outbox, before.outbox);
        assertRecords(recovered.counts, before.counts);
        const factsRecovered = await inspectRuntime(query);
        assert.notEqual(factsRecovered.bootId, factsAfterReset.bootId);
        assertRecords(factsRecovered.counts, factsBefore.counts);
        assertRecords(factsRecovered.outbox, factsBefore.outbox);
        assertRecords(
          unwrap(
            await client.call({
              action: "nullmem-query",
              query,
              value: { ...query, limit: 100 },
            }),
          ),
          memoryBefore,
        );
        const memoryRetried = unwrap<{ memoryRevision: number }>(
          await client.call({
            action: "nullmem-put",
            query,
            value: memoryCommand,
          }),
        );
        assert.equal(memoryRetried.memoryRevision, 2);
        writeFileSync(
          resolve(evidence, "native-nullmem-restart-proof.json"),
          JSON.stringify(
            { firstPid, nextPid, memoryBefore, memoryRetried },
            null,
            2,
          ),
        );
        assertRecords(await runtime(query).appendRuntimeFact(factCommand), {
          ...query,
          appended: false,
          receipt: factReceipt,
        });
        assertRecords(
          await runtime(query).readRuntimeFacts({
            ...factHead,
            afterSeq: -1,
            limit: 200,
          }),
          factPage,
        );
        writeFileSync(
          resolve(evidence, "native-runtime-fact-restart-proof.json"),
          JSON.stringify(
            {
              firstPid,
              nextPid,
              factLost,
              factReceipt,
              factPage,
              before: factsBefore,
              afterReset: factsAfterReset,
              recovered: factsRecovered,
            },
            null,
            2,
          ),
        );
        assert.equal(
          unwrap<{ content: string }>(
            await client.call({
              action: "content",
              query,
              value: { ...query, version: history[0].command.expected },
            }),
          ).content,
          "",
        );
        for (const index of [0, 9, 23, 24]) {
          const entry = history[index];
          const read = unwrap<{ content: string }>(
            await client.call({
              action: "content",
              query,
              value: { ...query, version: entry.receipt.version },
            }),
          );
          assert.equal(read.content, entry.content);
        }
        const retry = unwrap<BranchAppendOutcome>(
          await client.call({
            action: "append",
            query,
            value: remap(query, history[0].command),
          }),
        );
        assertRecords(retry, {
          status: "duplicate",
          receipt: { ...history[0].receipt, target: query.target },
        });
        assert.equal(recovered.r2Calls, 0);
        writeFileSync(
          resolve(evidence, "restart-proof.json"),
          JSON.stringify(
            {
              firstPid,
              nextPid,
              beforeBoot: before.bootId,
              afterResetBoot: afterReset.bootId,
              recoveredBoot: recovered.bootId,
              counts: recovered.counts,
              outbox: recovered.outbox,
            },
            null,
            2,
          ),
        );
      },
    );
  } finally {
    await client.close();
    for (const input of inputs)
      assert.equal(
        hash(readFileSync(input.realpath)),
        input.sha256,
        `source changed during test: ${input.path}`,
      );
    const files: { path: string; sha256: string }[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = resolve(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else
          files.push({
            path: relative(evidence, path),
            sha256: hash(readFileSync(path)),
          });
      }
    };
    walk(resolve(evidence, "native-state"));
    writeFileSync(
      resolve(evidence, "native-result.json"),
      JSON.stringify(
        {
          results,
          pins,
          persistedFiles: files,
          allPassed: results.every((r) => r.passed),
          claims: {
            nativeSQLite: results.every((result) => result.passed),
            actualObjectReset: results.some(
              (result) =>
                result.passed && result.name.includes("actual object reset"),
            ),
            subprocessRestart: results.some(
              (result) =>
                result.passed && result.name.includes("OS subprocess restart"),
            ),
            consumerRetries: false,
            productionCompatibilityDate: false,
          },
        },
        null,
        2,
      ),
    );
  }
  if (results.some((r) => !r.passed)) process.exitCode = 1;
}

if (process.argv.includes("--child")) await child();
else await main();

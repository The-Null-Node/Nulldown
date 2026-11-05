import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type * as MiniflareModule from "miniflare";
import type { BlobObjectStore, SqlMetadataStore } from "../../src/server/ports";
import { createBranchRepository } from "../../functions/api/_lib/branches/storage/repository";
import { createBranchDiffRepository } from "../../functions/api/_lib/branches/storage/diff-log";
import { applicationSeed } from "../../packages/nulldown-state-plane/test/application-scenarios.fixture";
import { branchStateShardName } from "../../packages/nulldown-state-plane/src/shard-router";
import {
  BranchAppendCommand,
  type BranchStateVersion,
} from "../../shared/drop/branch-state";
import {
  collectBenchmarkSamples,
  collectWarmupSamples,
  summarizeBenchmarkSamples,
  type BenchmarkSample,
} from "./benchmark-metrics";

const arg = (name: string) =>
  process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = resolve(arg("root")!);
const evidence = resolve(arg("evidence")!);
const requestedSize = Number(arg("size") ?? "65536");
if (![8192, 65536, 262144].includes(requestedSize))
  throw Error("size must be one of 8192, 65536, or 262144 bytes");
const require = createRequire(resolve(root, "package.json"));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } =
  require("miniflare") as typeof MiniflareModule;
const sourcePins = JSON.parse(
  readFileSync(resolve(evidence, "source-pins.json"), "utf8"),
) as { bunVersion: string };
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const content = (
  `# Synthetic benchmark ${"migration rehearsal ".repeat(20)}\n` +
  "x".repeat(requestedSize)
).slice(0, requestedSize);
const rootId = `BenchRoot${requestedSize / 1024}K`;
const seed = applicationSeed("benchmark-writer", rootId, content);
const placement = seed.placement;
const target = {
  rootDropId: seed.branch.rootDropId,
  branchId: seed.branch.branchId,
};
const options = {
  rootPath: root,
  modulesRoot: evidence,
  resourceTmpPath: resolve(evidence, `runtime-${process.pid}`),
  resourcePersistencePath: resolve(evidence, "native-state"),
  host: "127.0.0.1",
  port: 0,
  cf: false,
  telemetry: { enabled: false },
  log: new Log(LogLevel.NONE),
  unsafeInspectDurableObjects: true,
  workers: [
    {
      name: "state",
      modulesRoot: evidence,
      modules: [
        {
          type: "ESModule" as const,
          path: resolve(evidence, "state-worker.mjs"),
        },
      ],
      compatibilityDate: "2026-08-26",
      bindings: { STATE_PLANE_LOCAL_TEST: "1" },
      durableObjects: {
        BRANCH_STATE: {
          className: "BranchStateObject",
          useSQLite: true,
          unsafeUniqueKey: "migration-bench-v1",
        },
      },
      outboundService: () => {
        throw Error("NETWORK_DISABLED");
      },
    },
    {
      name: "benchmark",
      modulesRoot: evidence,
      modules: [
        {
          type: "ESModule" as const,
          path: resolve(evidence, "benchmark-worker.mjs"),
        },
      ],
      compatibilityDate: "2026-08-26",
      r2Buckets: { R2_BUCKET: "benchmark-r2" },
      d1Databases: { DB: "benchmark-d1" },
      serviceBindings: {
        BRANCH_STATE_SERVICE: {
          name: "state",
          entrypoint: "BranchStateService",
        },
      },
      outboundService: () => {
        throw Error("NETWORK_DISABLED");
      },
    },
  ],
} satisfies MiniflareModule.V4MiniflareOptions;
let runtimeGeneration = 0;
const createRuntime = () =>
  new Miniflare(
    convertV4MiniflareOptions({
      ...options,
      workers: [...options.workers].reverse(),
      resourceTmpPath: resolve(
        evidence,
        `runtime-${process.pid}-${runtimeGeneration++}`,
      ),
    }),
  );
let mf = createRuntime();
const samples: BenchmarkSample[] = [];
const coldSamples: BenchmarkSample[] = [];
const warmupSamples: BenchmarkSample[] = [];
const groupWallMs: Record<string, number> = {};
const journal = (phase: string, rows: BenchmarkSample[]) =>
  appendFileSync(
    resolve(evidence, "benchmark-attempts.jsonl"),
    rows.map((row) => JSON.stringify({ phase, ...row })).join("\n") + "\n",
  );
const environment = {
  bunVersion: sourcePins.bunVersion,
  nodeVersion: process.version,
  miniflareVersion: require("miniflare/package.json").version,
  compatibilityDate: "2026-08-26",
  persistence:
    "Miniflare native R2 + D1 + SQLite Durable Object, fresh per run",
  warmupCount: 10,
  sampleCountPerArmOperationConcurrency: 128,
  timeoutMs: 2000,
  reset:
    "cold: dispose Miniflare, reopen against same resourcePersistencePath, await server readiness, then time first HTTP request without operation warmup; warm: reuse live reopened runtime with 10 warmup requests per arm/operation",
  authorization:
    "excluded: direct production adapter calls after authorization boundary",
  instrumentation: {
    dependencyCounts:
      "not instrumented in timed calls; adapter call topology is recorded in equivalence.caveat",
    cacheState:
      "native caches are not independently cleared or inspected; warm samples follow per-arm/operation warmups; cold samples use a separately reopened runtime per arm/operation",
    coldSamplesPerArmOperation: 5,
  },
  synthetic: {
    targetBytes: requestedSize,
    rootId: target.rootDropId,
    branchId: target.branchId,
    utf8Bytes: new TextEncoder().encode(content).length,
    contentSha256: createHash("sha256").update(content).digest("hex"),
  },
};
try {
  const bucket = await mf.getR2Bucket("R2_BUCKET", "benchmark");
  const database = await mf.getD1Database("DB", "benchmark");
  // Untimed host seeding adapts only the portable operations actually required.
  // All timed production adapters execute inside workerd.
  const blobs: BlobObjectStore = {
    async get(key) {
      const object = await bucket.get(key);
      return (
        object && {
          key,
          etag: object.etag,
          text: () => object.text(),
          json: async <T>() => JSON.parse(await object.text()) as T,
        }
      );
    },
    async head(key) {
      const object = await bucket.head(key);
      return object && { key, etag: object.etag };
    },
    async put(key, value, options) {
      if (typeof value !== "string")
        throw Error("benchmark_seed_requires_string");
      const object = await bucket.put(key, value, options);
      return object && { key, etag: object.etag };
    },
    async delete(keys) {
      await bucket.delete(keys);
    },
    async list(options) {
      const page = await bucket.list(options);
      return {
        objects: page.objects.map((object) => ({
          key: object.key,
          etag: object.etag,
        })),
        truncated: page.truncated,
        cursor: page.truncated ? page.cursor : undefined,
      };
    },
  };
  const sql: SqlMetadataStore = { prepare: (query) => database.prepare(query) };
  assert.ok(sql, "D1 SQL adapter available");
  for (const file of [
    "0001_initial.sql",
    "0002_metadata.sql",
    "0003_void_data_store.sql",
    "0004_resolved_heap_delta.sql",
    "0005_resolved_node_payloads.sql",
    "0006_nullmem_records.sql",
    "0007_search_index_fix.sql",
    "0008_branch_runtime_facts.sql",
    "0009_openauth_principals.sql",
    "0010_account_key_exchange.sql",
    "0011_cli_device_auth.sql",
    "0012_account_remote_library.sql",
    "0013_cli_device_delegation.sql",
    "0014_account_encryption_recipient.sql",
    "0015_account_preferences.sql",
  ]) {
    const source = readFileSync(resolve(root, "migrations", file), "utf8")
      .replace(/^--.*$/gm, "")
      .replace(/CREATE TRIGGER[\s\S]*?END\s*;/gi, "");
    for (const statement of source
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean))
      await database.prepare(statement).run();
  }
  const repository = createBranchRepository({ blobs, sql });
  const initialSnapshot = {
    version: 1 as const,
    snapshotId: 0,
    rootDropId: target.rootDropId,
    branchId: target.branchId,
    parentSnapshotId: null,
    seq: 0,
    eventIds: [],
    checkpointed: true,
    textLength: content.length,
    createdAt: 1_700_000_000_000,
  };
  const doName = await branchStateShardName({ target, placement });
  const namespace = await mf.getDurableObjectNamespace("BRANCH_STATE", "state");
  const stub = namespace.get(namespace.idFromName(doName)) as unknown as {
    seedLocalFixtures(values: (typeof seed)[]): Promise<unknown>;
    append(
      command: ReturnType<BranchAppendCommand["toRecord"]>,
    ): Promise<unknown>;
    readHead(query: {
      target: typeof target;
      placement: typeof placement;
    }): Promise<{
      ok: true;
      value: {
        version: BranchStateVersion;
      };
    }>;
    readContent(query: {
      target: typeof target;
      placement: typeof placement;
      version: {
        snapshotId: number;
        eventSeq: number;
        sourceContentHash: string;
      };
    }): Promise<{ ok: true; value: { content: string } }>;
  };
  await stub.seedLocalFixtures([seed]);
  const stateHead = await stub.readHead({ target, placement });
  assert.equal(stateHead.ok, true);
  const event = {
    eventId: "benchmark-history-event-1",
    seq: 0,
    dropId: target.rootDropId,
    sourceClientId: "benchmark-client",
    createdAt: 1_700_000_000_100,
    ops: [
      {
        type: "insert" as const,
        start: content.length,
        end: content.length,
        text: "history event 1\n",
      },
    ],
    metadata: { followsSeq: -1 },
  };
  const append = await BranchAppendCommand.create({
    target,
    placement,
    expected: stateHead.value.version,
    event,
  });
  await stub.append(append.toRecord());
  const currentHead = await stub.readHead({ target, placement });
  assert.equal(currentHead.ok, true);
  const currentContent = content + "history event 1\n";
  const legacyBranch = {
    ...seed.branch,
    headSnapshotId: 1,
    headEventSeq: 0,
    updatedAt: 1_700_000_000_100,
  };
  const currentSnapshot = {
    version: 1 as const,
    snapshotId: 1,
    rootDropId: target.rootDropId,
    branchId: target.branchId,
    parentSnapshotId: 0,
    seq: 1,
    eventIds: [event.eventId],
    checkpointed: true,
    patchStartSeq: 0,
    patchEndSeq: 0,
    sourceContentHash: currentHead.value.version.sourceContentHash,
    textLength: currentContent.length,
    createdAt: 1_700_000_000_100,
  };
  const legacyEvent = { ...event, snapshotId: 1 };
  await repository.writeBranch(legacyBranch);
  await repository.writeSnapshot(initialSnapshot);
  await repository.writeSnapshot(currentSnapshot);
  await repository.writeSnapshotCheckpoint(
    target.rootDropId,
    target.branchId,
    0,
    content,
  );
  await repository.writeSnapshotCheckpoint(
    target.rootDropId,
    target.branchId,
    1,
    currentContent,
  );
  const diffRepository = createBranchDiffRepository({ blobs, sql });
  await diffRepository.writeBranchDiffEvent(
    target.rootDropId,
    target.branchId,
    legacyEvent,
  );
  await diffRepository.writeBranchDiffEventIdMarker(
    target.rootDropId,
    target.branchId,
    legacyEvent,
  );
  const requestAdapter = async (
    arm: "legacy" | "state-plane",
    operation: "content" | "history" | "resolved-query",
    signal?: AbortSignal,
  ) => {
    const response = await fetch(
      new URL(
        `/__benchmark?arm=${arm}&operation=${operation}&root=${encodeURIComponent(target.rootDropId)}&branch=${encodeURIComponent(target.branchId)}&q=migration`,
        await mf.ready,
      ),
      { signal },
    );
    const value: unknown = await response.json();
    assert.equal(response.status, 200, `benchmark ${arm}/${operation} status`);
    if (operation === "resolved-query" && value && typeof value === "object") {
      const result = value as Record<string, unknown>;
      return Object.fromEntries(
        [
          "rootDropId",
          "branchId",
          "snapshotId",
          "resolverId",
          "resolverVersion",
          "sourceContentHash",
          "nodeCount",
          "nodes",
        ].map((key) => [key, result[key]]),
      );
    }
    return value;
  };
  const baselines = {
    content: {
      legacy: await requestAdapter("legacy", "content"),
      "state-plane": await requestAdapter("state-plane", "content"),
    },
    history: {
      legacy: await requestAdapter("legacy", "history"),
      "state-plane": await requestAdapter("state-plane", "history"),
    },
    "resolved-query": {
      legacy: await requestAdapter("legacy", "resolved-query"),
      "state-plane": await requestAdapter("state-plane", "resolved-query"),
    },
  };
  assert.deepEqual(baselines.content.legacy, {
    content: currentContent,
    snapshotId: 1,
    eventSeq: 0,
  });
  assert.deepEqual(baselines.history.legacy, {
    events: [legacyEvent],
    snapshotId: 1,
    eventSeq: 0,
  });
  for (const operation of ["content", "history", "resolved-query"] as const) {
    const expected = hash(baselines[operation].legacy);
    assert.equal(
      hash(baselines[operation]["state-plane"]),
      expected,
      `${operation}: legacy/State Plane semantic output equivalence`,
    );
  }
  for (let round = 0; round < 5; round++) {
    for (const operation of ["content", "history", "resolved-query"] as const) {
      const order =
        round % 2 === 0
          ? (["legacy", "state-plane"] as const)
          : (["state-plane", "legacy"] as const);
      for (const arm of order) {
        await mf.dispose();
        mf = createRuntime();
        await mf.ready;
        const rows = await collectBenchmarkSamples({
          operation: `cold/${operation}`,
          arm,
          iterations: 1,
          warmups: 0,
          timeoutMs: 10_000,
          hash,
          run: async (_, signal) => {
            const output = await requestAdapter(arm, operation, signal);
            assert.equal(
              hash(output),
              hash(baselines[operation][arm]),
              `cold ${arm}/${operation} semantic output`,
            );
            return output;
          },
        });
        const row = { ...rows[0], iteration: round };
        coldSamples.push(row);
        journal("cold", [row]);
      }
    }
  }
  const operationRunners = {
    content: {
      legacy: (signal: AbortSignal) =>
        requestAdapter("legacy", "content", signal),
      "state-plane": (signal: AbortSignal) =>
        requestAdapter("state-plane", "content", signal),
    },
    history: {
      legacy: (signal: AbortSignal) =>
        requestAdapter("legacy", "history", signal),
      "state-plane": (signal: AbortSignal) =>
        requestAdapter("state-plane", "history", signal),
    },
    "resolved-query": {
      legacy: (signal: AbortSignal) =>
        requestAdapter("legacy", "resolved-query", signal),
      "state-plane": (signal: AbortSignal) =>
        requestAdapter("state-plane", "resolved-query", signal),
    },
  };
  const runArm = async (
    arm: "legacy" | "state-plane",
    concurrency: number,
    operation: keyof typeof operationRunners,
    iterations: number,
  ) => {
    const run = operationRunners[operation][arm];
    const started = performance.now();
    const result = await Promise.all(
      Array.from({ length: concurrency }, async () =>
        collectBenchmarkSamples({
          operation,
          arm,
          iterations,
          warmups: 0,
          timeoutMs: 2000,
          run: async (_iteration, signal) => {
            const output = await run(signal);
            assert.equal(
              hash(output),
              hash(baselines[operation][arm]),
              `${arm}/${operation} sample semantic output`,
            );
            return output;
          },
          hash,
        }),
      ),
    );
    const wallMs = performance.now() - started;
    return {
      rows: result.flat().map((row, index) => ({
        ...row,
        operation: `${operation}/concurrency-${concurrency}`,
        iteration: row.iteration * concurrency + Math.floor(index / iterations),
      })),
      wallMs,
    };
  };
  for (const concurrency of [1, 4, 16]) {
    const order =
      concurrency === 4
        ? (["state-plane", "legacy"] as const)
        : (["legacy", "state-plane"] as const);
    for (const operation of ["content", "history", "resolved-query"] as const) {
      for (const arm of order) {
        const diagnostics = await collectWarmupSamples({
          operation: `${operation}/concurrency-${concurrency}`,
          arm,
          count: 10,
          timeoutMs: 2000,
          run: async (_iteration, signal) => {
            const output = await operationRunners[operation][arm](signal);
            assert.equal(
              hash(output),
              hash(baselines[operation][arm]),
              `warmup ${arm}/${operation} semantic output`,
            );
            return output;
          },
          hash,
        });
        warmupSamples.push(...diagnostics);
        journal("warmup", diagnostics);
        if (diagnostics.some((sample) => !sample.ok)) {
          writeFileSync(
            resolve(evidence, "benchmark-warmup-samples.jsonl"),
            warmupSamples.map((sample) => JSON.stringify(sample)).join("\n") +
              "\n",
          );
          throw Error(
            `Warmup failure ${arm}/${operation}; timed samples not run`,
          );
        }
      }
      const grouped = Object.fromEntries(
        order.map((arm) => [arm, [] as BenchmarkSample[]]),
      ) as Record<(typeof order)[number], BenchmarkSample[]>;
      const activeWallMs = { legacy: 0, "state-plane": 0 };
      const perLane = Math.max(1, 16 / concurrency);
      for (let batch = 0; batch < 8; batch++) {
        for (const arm of batch % 2 ? [...order].reverse() : order) {
          const measured = await runArm(arm, concurrency, operation, perLane);
          activeWallMs[arm] += measured.wallMs;
          grouped[arm].push(
            ...measured.rows.map((row) => ({
              ...row,
              iteration: batch * 16 + row.iteration,
            })),
          );
          journal(
            "warm",
            measured.rows.map((row) => ({
              ...row,
              iteration: batch * 16 + row.iteration,
            })),
          );
        }
      }
      for (const arm of order) {
        samples.push(...grouped[arm]);
        groupWallMs[`${arm}/${operation}/concurrency-${concurrency}`] =
          activeWallMs[arm];
      }
    }
  }
  const report = {
    schemaVersion: 1,
    title: "Controlled legacy adapter vs State Plane SQLite adapter benchmark",
    workload: { sizeBytes: requestedSize, operationHistoryEvents: 1 },
    environment,
    equivalence: {
      verifiedBeforeTiming: true,
      responseHashes: Object.fromEntries(
        (["content", "history", "resolved-query"] as const).map((operation) => [
          operation,
          hash(baselines[operation].legacy),
        ]),
      ),
      provenance:
        "content snapshotId=1,eventSeq=0; history has one accepted event at seq=0",
      caveat:
        "both paths execute in workerd through the same loopback HTTP boundary; State Plane uses service-binding RPC to SQLite DO; legacy uses R2+D1 production adapters. Throughput uses active batch wall time, excluding the alternating arm's batches.",
    },
    coldSummaries: Object.fromEntries(
      (["content", "history", "resolved-query"] as const).map((operation) => [
        operation,
        Object.fromEntries(
          (["legacy", "state-plane"] as const).map((arm) => [
            arm,
            {
              ...summarizeBenchmarkSamples(
                coldSamples.filter(
                  (sample) =>
                    sample.operation === `cold/${operation}` &&
                    sample.arm === arm,
                ),
              ),
              label:
                "exploratory first request after Miniflare dispose/reopen; n=5; not a deployment cold start",
            },
          ]),
        ),
      ]),
    ),
    sourcePins: "source-pins.json",
    summaries: Object.fromEntries(
      [...new Set(samples.map((s) => s.operation))].map((operation) => [
        operation,
        Object.fromEntries(
          (["legacy", "state-plane"] as const).map((arm) => {
            const selected = samples.filter(
              (s) => s.operation === operation && s.arm === arm,
            );
            const measuredWallMs = groupWallMs[`${arm}/${operation}`];
            const quantilesAndFailures = summarizeBenchmarkSamples(selected);
            return [
              arm,
              {
                ...quantilesAndFailures,
                groupWallMs: measuredWallMs,
                throughputPerSecond: selected.length / (measuredWallMs / 1000),
                successfulThroughputPerSecond:
                  selected.filter((sample) => sample.ok).length /
                  (measuredWallMs / 1000),
              },
            ];
          }),
        ),
      ]),
    ),
    samples,
    coldSamples,
    warmupSamples,
  };
  writeFileSync(
    resolve(evidence, "benchmark-report.json"),
    JSON.stringify(report, null, 2),
  );
  writeFileSync(
    resolve(evidence, "benchmark-samples.jsonl"),
    samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n",
  );
  writeFileSync(
    resolve(evidence, "benchmark-cold-samples.jsonl"),
    coldSamples.map((sample) => JSON.stringify(sample)).join("\n") + "\n",
  );
  writeFileSync(
    resolve(evidence, "benchmark-warmup-samples.jsonl"),
    warmupSamples.map((sample) => JSON.stringify(sample)).join("\n") + "\n",
  );
  console.log(
    JSON.stringify(
      { evidence, environment, summaries: report.summaries },
      null,
      2,
    ),
  );
  if (
    samples.some((sample) => !sample.ok) ||
    coldSamples.some((sample) => !sample.ok)
  )
    process.exitCode = 1;
} finally {
  await mf.dispose();
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type * as MiniflareModule from "miniflare";
import { readFileSync } from "node:fs";
import type { BranchMigrationChunk } from "../../shared/drop/branch-migration";

const root = realpathSync(
  resolve(dirname(new URL(import.meta.url).pathname), "../.."),
);
const arg = process.argv
  .find((value) => value.startsWith("--evidence="))
  ?.slice(11);
const tokenFile = process.argv
  .find((value) => value.startsWith("--token-file="))
  ?.slice(13);
const baseUrl = process.argv
  .find((value) => value.startsWith("--base-url="))
  ?.slice(11)
  ?.replace(/\/$/, "");
const runId =
  process.argv.find((value) => value.startsWith("--run-id="))?.slice(9) ??
  `native-${Date.now().toString(36)}`;
assert.match(
  runId,
  /^[A-Za-z0-9_-]{1,32}$/,
  "--run-id must be a bounded safe identifier",
);
assert.ok(arg, "Use --evidence=/absolute/new/evidence-directory");
const evidence = resolve(arg);
assert.ok(!existsSync(evidence), "Evidence path must be fresh");
mkdirSync(evidence, { recursive: false, mode: 0o700 });
mkdirSync(resolve(evidence, "tmp"), { mode: 0o700 });
const require = createRequire(resolve(root, "package.json"));
const runtimeRequire = createRequire(
  resolve(root, "node_modules/wrangler/package.json"),
);
const hash = (input: string | Uint8Array) =>
  createHash("sha256").update(input).digest("hex");
const tokenInput = tokenFile
  ? readFileSync(resolve(tokenFile), "utf8").trim()
  : undefined;
const suppliedToken =
  process.env.MIGRATION_REHEARSAL_TOKEN ??
  (tokenInput?.startsWith("{")
    ? JSON.parse(tokenInput).MIGRATION_REHEARSAL_TOKEN
    : tokenInput);
assert.ok(
  !baseUrl || suppliedToken,
  "Hosted rehearsal requires a supplied token",
);
if (baseUrl)
  assert.equal(
    new URL(baseUrl).protocol,
    "https:",
    "Hosted rehearsal requires HTTPS",
  );
const rehearsalToken = suppliedToken ?? randomBytes(32).toString("base64url");
assert.ok(
  rehearsalToken.length >= 32 && rehearsalToken.length <= 512,
  "MIGRATION_REHEARSAL_TOKEN must be 32-512 characters",
);
const esbuild = require("esbuild") as {
  build(
    options: Record<string, unknown>,
  ): Promise<{ metafile?: { inputs: Record<string, unknown> } }>;
};
const buildOptions = {
  absWorkingDir: root,
  entryPoints: [
    "packages/nulldown-state-plane/test/migration-rehearsal.fixture.ts",
  ],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["cloudflare:workers"],
  outfile: resolve(evidence, "rehearsal-worker.mjs"),
  metafile: true,
};
const build = await esbuild.build({ ...buildOptions, write: false });
const pinned = new Set([
  ...Object.keys(build.metafile!.inputs),
  "scripts/state-plane/run-migration-rehearsal.ts",
  "bun.lock",
  "packages/nulldown-state-plane/wrangler.migration-rehearsal.jsonc",
  "packages/nulldown-state-plane/migration-rehearsal-configuration.d.ts",
  ...[
    "initial.sql",
    "metadata.sql",
    "void_data_store.sql",
    "resolved_heap_delta.sql",
    "resolved_node_payloads.sql",
    "nullmem_records.sql",
    "search_index_fix.sql",
    "branch_runtime_facts.sql",
    "openauth_principals.sql",
    "account_key_exchange.sql",
    "cli_device_auth.sql",
    "account_remote_library.sql",
    "cli_device_delegation.sql",
    "account_encryption_recipient.sql",
    "account_preferences.sql",
  ].map(
    (name, index) => `migrations/${String(index + 1).padStart(4, "0")}_${name}`,
  ),
]);
const inputs = [...pinned].map((path) => ({
  path,
  sha256: hash(readFileSync(resolve(root, path))),
}));
writeFileSync(
  resolve(evidence, "source-pins-before-build.json"),
  JSON.stringify(inputs, null, 2),
);
const compiled = await esbuild.build(buildOptions);
assert.deepEqual(
  Object.keys(compiled.metafile!.inputs).sort(),
  Object.keys(build.metafile!.inputs).sort(),
  "dependency graph changed during build",
);
for (const input of inputs)
  assert.equal(
    hash(readFileSync(resolve(root, input.path))),
    input.sha256,
    `source changed during compilation: ${input.path}`,
  );
writeFileSync(
  resolve(evidence, "source-pins.json"),
  JSON.stringify(
    {
      root,
      commit: require("node:child_process")
        .execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        })
        .trim(),
      bunVersion: Bun.version,
      compatibilityDate: baseUrl ? "2026-11-05" : "2026-09-02",
      bundleProvenance:
        "discover-discard-pin-compile-verify; hosted deployment version is recorded separately in retained telemetry",
      workerSha256: hash(
        readFileSync(resolve(evidence, "rehearsal-worker.mjs")),
      ),
      dependencies: ["miniflare", "workerd", "wrangler", "esbuild"].map(
        (name) => {
          const path = runtimeRequire.resolve(name + "/package.json");
          const bytes = readFileSync(path);
          return {
            name,
            version: JSON.parse(bytes.toString()).version,
            sha256: hash(bytes),
          };
        },
      ),
      inputs,
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600, flag: "wx" },
);
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = runtimeRequire(
  "miniflare",
) as typeof MiniflareModule;
const options: MiniflareModule.V4MiniflareOptions = {
  rootPath: root,
  modulesRoot: evidence,
  resourceTmpPath: resolve(evidence, "tmp"),
  resourcePersistencePath: resolve(evidence, "native"),
  host: "127.0.0.1",
  port: 0,
  cf: false,
  telemetry: { enabled: false },
  log: new Log(LogLevel.ERROR),
  workers: [
    {
      name: "migration-rehearsal",
      modulesRoot: evidence,
      modules: [
        { type: "ESModule", path: resolve(evidence, "rehearsal-worker.mjs") },
      ],
      compatibilityDate: "2026-09-02",
      bindings: { MIGRATION_REHEARSAL_TOKEN: rehearsalToken },
      durableObjects: {
        REHEARSAL: {
          className: "MigrationRehearsalObject",
          useSQLite: true,
          unsafeUniqueKey: "migration-rehearsal-fixed16-v1",
        },
      },
      r2Buckets: { LEGACY_R2: "migration-rehearsal-legacy" },
      d1Databases: { LEGACY_D1: "migration-rehearsal-legacy" },
      outboundService() {
        throw Error("REHEARSAL_NETWORK_DISABLED");
      },
    },
  ],
};
let mf: MiniflareModule.Miniflare | undefined = baseUrl
  ? undefined
  : new Miniflare(convertV4MiniflareOptions(options));
const trace: unknown[] = [];
try {
  let worker = mf ? await mf.getWorker("migration-rehearsal") : undefined;
  const target = {
    rootDropId: `MigrationRehearsal-${runId}`,
    branchId: `writer-${runId}`,
  };
  const request = async (
    action: string,
    values: Record<string, unknown> = {},
  ) => {
    const started = performance.now();
    const startedAt = new Date().toISOString();
    const requestId = `${runId}-${trace.length}-${randomBytes(4).toString("hex")}`;
    const requestBody = JSON.stringify({
      action,
      ...values,
      target: values.target ?? target,
      requestId,
    });
    try {
      const response = baseUrl
        ? await fetch(`${baseUrl}/fixture`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${rehearsalToken}`,
            },
            body: requestBody,
            signal: AbortSignal.timeout(90_000),
          })
        : await worker!.fetch("https://migration.invalid/fixture", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${rehearsalToken}`,
            },
            body: requestBody,
            signal: AbortSignal.timeout(15_000),
          });
      const body = await response.text();
      const row = {
        action,
        requestId,
        startedAt,
        completedAt: new Date().toISOString(),
        status: response.status,
        elapsedMs: performance.now() - started,
        responseHash: hash(body),
        responseBytes: Buffer.byteLength(body),
        response: body,
      };
      trace.push(row);
      appendFileSync(
        resolve(evidence, "request-journal.ndjson"),
        JSON.stringify(row) + "\n",
        { mode: 0o600 },
      );
      assert.equal(
        response.headers.get("x-request-id"),
        requestId,
        "response correlation",
      );
      return { response, body };
    } catch (error) {
      appendFileSync(
        resolve(evidence, "request-journal.ndjson"),
        JSON.stringify({
          action,
          requestId,
          startedAt,
          failedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : "request_failed",
        }) + "\n",
        { mode: 0o600 },
      );
      throw error;
    }
  };
  const migrationId = `migration-rehearsal-${runId}`;
  const certificate = { target, sourceGeneration: 0, migrationId };
  const database = mf
    ? await mf.getD1Database("LEGACY_D1", "migration-rehearsal")
    : undefined;
  for (const file of database
    ? [
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
      ]
    : []) {
    const sql = readFileSync(resolve(root, "migrations", file), "utf8")
      .replace(/^--.*$/gm, "")
      .replace(/CREATE TRIGGER[\s\S]*?END\s*;/gi, "");
    for (const statement of sql
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean))
      await database!.prepare(statement).run();
  }
  const seeded = await request("seedSource", { migrationId });
  assert.equal(seeded.response.status, 200, seeded.body);
  const prepared = await request("prepareImport", {
    sourceGeneration: 0,
    migrationId,
  });
  assert.equal(prepared.response.status, 200, prepared.body);
  const preparedValue = JSON.parse(prepared.body).value;
  const manifest = preparedValue.manifest;
  const chunks = await Promise.all(
    Array.from(
      { length: preparedValue.chunkCount as number },
      async (_, index) => {
        const response = await request("preparedChunk", { migrationId, index });
        assert.equal(response.response.status, 200, response.body);
        return JSON.parse(response.body).value as BranchMigrationChunk;
      },
    ),
  );
  const content = "abc";
  assert.deepEqual(preparedValue.eventIds, [
    "source-batch-1",
    "source-batch-2",
    "source-single-3",
  ]);
  assert.equal(preparedValue.runtimeFactCount, 1);
  assert.deepEqual(preparedValue.memoryIds, [
    "rehearsal-fact",
    "rehearsal-procedure",
  ]);
  const initialProgress = preparedValue.progress;
  const frozenWriter = await request("staleWriter");
  assert.equal(frozenWriter.response.status, 409);
  assert.equal(
    JSON.parse(frozenWriter.body).error,
    "routing_placement_mismatch",
  );
  if (initialProgress.phase === "importing") {
    const premature = await request("verify", {
      migrationId,
      generation: manifest.generation,
      certificate,
    });
    assert.notEqual(
      premature.response.status,
      200,
      "incomplete import admission fails closed",
    );
    const stale = await request("putChunk", {
      chunk: chunks[0],
      generation: 0,
    });
    assert.notEqual(stale.response.status, 200, "stale generation rejected");
  }
  const tampered = structuredClone(chunks[0]);
  tampered.payloadHash = `sha256:${"A".repeat(43)}`;
  const tamperResult = await request("putChunk", {
    chunk: tampered,
    generation: manifest.generation,
  });
  assert.notEqual(
    tamperResult.response.status,
    200,
    "tampered content-addressed chunk rejected",
  );
  for (const chunk of chunks.slice(initialProgress.nextChunk ?? 0)) {
    const stored = await request("putChunk", {
      chunk,
      generation: manifest.generation,
    });
    assert.equal(stored.response.status, 200, stored.body);
    if (mf && chunk.index === 0 && chunks.length > 1) {
      await mf.dispose();
      mf = new Miniflare(convertV4MiniflareOptions(options));
      worker = await mf.getWorker("migration-rehearsal");
      const partial = await request("progress", { migrationId });
      assert.equal(
        JSON.parse(partial.body).value.nextChunk,
        1,
        "partial cursor survived restart before remaining chunks",
      );
      const incomplete = await request("verify", {
        migrationId,
        generation: manifest.generation,
        certificate,
      });
      assert.equal(
        incomplete.response.status,
        409,
        "partial import cannot activate",
      );
      const replay = await request("putChunk", {
        chunk,
        generation: manifest.generation,
      });
      assert.equal(
        replay.response.status,
        200,
        "persisted chunk retry is idempotent",
      );
    }
  }
  if (mf) {
    await mf.dispose();
    mf = new Miniflare(convertV4MiniflareOptions(options));
    worker = await mf.getWorker("migration-rehearsal");
  }
  const resumed = await request("progress", { migrationId });
  assert.equal(resumed.response.status, 200, resumed.body);
  assert.equal(
    JSON.parse(resumed.body).value.nextChunk,
    chunks.length,
    "chunk cursor survived native restart",
  );
  if (JSON.parse(resumed.body).value.phase === "importing") {
    const verified = await request("verify", {
      migrationId,
      generation: manifest.generation,
      certificate,
    });
    assert.equal(verified.response.status, 200, verified.body);
  }
  const transferred = await request("transferSource", {
    migrationId,
    certificate,
  });
  assert.equal(transferred.response.status, 200, transferred.body);
  if (mf) {
    await mf.dispose();
    mf = new Miniflare(convertV4MiniflareOptions(options));
    worker = await mf.getWorker("migration-rehearsal");
  }
  const activated = await request("activate", {
    migrationId,
    generation: manifest.generation,
    certificate,
  });
  assert.equal(activated.response.status, 200, activated.body);
  const staleDestination = await request("staleWriter", { destination: true });
  assert.equal(staleDestination.response.status, 409);
  assert.equal(
    JSON.parse(staleDestination.body).error,
    "routing_generation_mismatch",
  );
  const written = await request("postActivationWrites", { migrationId });
  assert.equal(written.response.status, 200, written.body);
  const postWriteResult = JSON.parse(written.body).value;
  assert.deepEqual(postWriteResult.eventIds, [
    `${migrationId}-native-batch-a`,
    `${migrationId}-native-batch-b`,
  ]);
  assert.ok(postWriteResult.runtimeId && postWriteResult.memoryId);
  if (mf) {
    await mf.dispose();
    mf = new Miniflare(convertV4MiniflareOptions(options));
    worker = await mf.getWorker("migration-rehearsal");
  }
  const readback = await request("readback", { migrationId });
  assert.equal(readback.response.status, 200, readback.body);
  const stateAfterRestart = JSON.parse(readback.body).value;
  const sourceRecords = chunks.flatMap((chunk) => chunk.payload);
  assert.deepEqual(
    stateAfterRestart.importedSnapshots,
    sourceRecords
      .filter((record) => record.kind === "snapshot")
      .map((record) => ({
        snapshot: record.value.snapshot,
        content: record.value.content,
      })),
    "exact imported snapshot records and content",
  );
  assert.deepEqual(
    stateAfterRestart.events.slice(0, 3),
    sourceRecords
      .filter((record) => record.kind === "event")
      .map((record) => record.value.event),
    "exact imported events",
  );
  assert.deepEqual(
    stateAfterRestart.runtimeFacts.slice(0, 1),
    sourceRecords
      .filter((record) => record.kind === "runtime-fact")
      .map((record) => record.value),
    "exact imported runtime facts",
  );
  const importedMemory = sourceRecords.find(
    (record) => record.kind === "nullmem",
  )!;
  for (const record of importedMemory.value.records)
    assert.deepEqual(
      stateAfterRestart.memoryRecords.find(
        (value: { recordId: string }) => value.recordId === record.recordId,
      ),
      record,
      "exact imported memory records",
    );
  assert.equal(stateAfterRestart.phase, "activated");
  assert.equal(stateAfterRestart.content, "abc!?");
  assert.deepEqual(
    stateAfterRestart.eventIds.slice(-2),
    postWriteResult.eventIds,
    "appended event identities survived restart",
  );
  assert.ok(stateAfterRestart.runtimeIds.includes(postWriteResult.runtimeId));
  assert.equal(
    stateAfterRestart.runtimeIds.at(-1),
    postWriteResult.runtimeId,
    "runtime identity survived restart",
  );
  assert.ok(
    stateAfterRestart.memoryIds.includes(`${migrationId}-native-memory`),
  );
  assert.equal(
    stateAfterRestart.memoryRevision,
    postWriteResult.memoryRevision,
    "memory revision survived restart",
  );
  assert.deepEqual(
    stateAfterRestart.acknowledgements
      .map((row: { eventId: string; acknowledgement: unknown }) => row.eventId)
      .sort(),
    ["source-batch-1", "source-batch-2", "source-single-3"],
  );
  assert.deepEqual(
    stateAfterRestart.acknowledgements
      .map(
        (row: {
          acknowledgement: { seq: number; snapshotId: number; status: string };
        }) => row.acknowledgement,
      )
      .sort((a: { seq: number }, b: { seq: number }) => a.seq - b.seq),
    [
      { eventId: "source-batch-1", seq: 0, snapshotId: 1, status: "accepted" },
      { eventId: "source-batch-2", seq: 1, snapshotId: 1, status: "accepted" },
      { eventId: "source-single-3", seq: 2, snapshotId: 2, status: "accepted" },
    ],
  );
  const rollback = await request("rollback", {
    migrationId,
    generation: manifest.generation,
    certificate,
  });
  assert.notEqual(
    rollback.response.status,
    200,
    "rollback refused after irreversible transfer and activation",
  );
  const forward = await request("activate", {
    migrationId,
    generation: manifest.generation,
    certificate,
  });
  assert.equal(
    forward.response.status,
    200,
    "activation retries recover forward",
  );
  assert.equal(
    (await request("seedSource", { migrationId })).response.status,
    200,
    "transferred source is stable on hosted rerun",
  );
  const recovered = await request("prepareImport", {
    sourceGeneration: 0,
    migrationId,
  });
  assert.equal(recovered.response.status, 200, recovered.body);
  assert.equal(
    JSON.parse(recovered.body).value.progress.phase,
    "activated",
    "persisted manifest supports redeploy readback",
  );
  const repeatedWrites = await request("postActivationWrites", { migrationId });
  assert.deepEqual(
    JSON.parse(repeatedWrites.body).value,
    postWriteResult,
    "post-activation fixture writes remain idempotent on recovery",
  );
  const abortRunId = `${runId.slice(0, 24)}-abort`;
  const abortTarget = {
    rootDropId: `MigrationRehearsal-${abortRunId}`,
    branchId: `writer-${abortRunId}`,
  };
  const abortMigrationId = `migration-rehearsal-${abortRunId}`;
  const abortCertificate = {
    target: abortTarget,
    sourceGeneration: 0,
    migrationId: abortMigrationId,
  };
  const abortSeed = await request("seedSource", {
    target: abortTarget,
    migrationId: abortMigrationId,
  });
  assert.equal(abortSeed.response.status, 200, abortSeed.body);
  if (JSON.parse(abortSeed.body).value.generation !== 1) {
    const abortPrepared = await request("prepareImport", {
      target: abortTarget,
      sourceGeneration: 0,
      migrationId: abortMigrationId,
    });
    assert.equal(abortPrepared.response.status, 200, abortPrepared.body);
    const abortManifest = JSON.parse(abortPrepared.body).value.manifest;
    const aborted = await request("rollback", {
      target: abortTarget,
      migrationId: abortMigrationId,
      generation: abortManifest.generation,
      certificate: abortCertificate,
    });
    assert.equal(aborted.response.status, 200, aborted.body);
    assert.equal(
      JSON.parse(aborted.body).value.generation,
      1,
      "destination rollback precedes source generation advance",
    );
  }
  const legacyWrite = await request("legacyWriteAfterAbort", {
    target: abortTarget,
    migrationId: abortMigrationId,
  });
  assert.equal(legacyWrite.response.status, 200, legacyWrite.body);
  assert.deepEqual(JSON.parse(legacyWrite.body).value, {
    phase: "legacy",
    generation: 1,
    eventId: `${abortMigrationId}-legacy-after-abort`,
    content: "abc!",
  });
  const progress = await request("progress", { migrationId });
  assert.equal(progress.response.status, 200, progress.body);
  assert.equal(JSON.parse(progress.body).value.phase, "activated");
  for (const input of inputs)
    assert.equal(
      hash(readFileSync(resolve(root, input.path))),
      input.sha256,
      `source changed during rehearsal: ${input.path}`,
    );
  assert.equal(
    hash(
      readFileSync(
        resolve(root, "scripts/state-plane/run-migration-rehearsal.ts"),
      ),
    ),
    inputs.find(
      (input) =>
        input.path === "scripts/state-plane/run-migration-rehearsal.ts",
    )!.sha256,
    "runner source changed during rehearsal",
  );
  writeFileSync(
    resolve(evidence, "native-trace.ndjson"),
    trace.map((row) => JSON.stringify(row)).join("\n") + "\n",
    { mode: 0o600, flag: "wx" },
  );
  writeFileSync(
    resolve(evidence, "summary.json"),
    JSON.stringify(
      {
        passed: true,
        evidence,
        hosted: Boolean(baseUrl),
        restartCoverage: baseUrl
          ? "same run supports readback after external redeployment; no in-run hosted restart injected"
          : "Miniflare dispose/reopen after first partial chunk, complete staging, source transfer, and postactivation writes",
        runId,
        synthetic: {
          target,
          contentSha256: hash(content),
          chunks: chunks.length,
          importedRecords: manifest.itemCount,
          eventIds: preparedValue.eventIds,
          runtimeFacts: preparedValue.runtimeFactCount,
          memoryIds: preparedValue.memoryIds,
        },
        assertions: [
          "stale legacy admission and stale destination append rejected",
          "actual Worker R2/D1 seed under durable source permit",
          "uncertain admission blocks freeze",
          "three real source events across batch and single append",
          "runtime fact and fact/procedure memory captured",
          "capture and payload commitment recomputed inside trusted fixture Worker",
          "incomplete admission fails closed",
          "stale generation rejected",
          "tampered chunk rejected",
          "chunk persistence and native restart/redeploy resume",
          "source transfer before activation and restart-forward recovery",
          "exact original public acknowledgements",
          "real postactivation batch/runtime/memory writes",
          "restart forward recovery",
          "rollback refused after transfer",
          "separate destination rollback then source abort generation advance",
          "legacy append accepted at reopened generation",
        ],
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600, flag: "wx" },
  );
} catch (error) {
  writeFileSync(
    resolve(evidence, "native-trace.ndjson"),
    trace.map((row) => JSON.stringify(row)).join("\n") + "\n",
    { mode: 0o600, flag: "wx" },
  );
  writeFileSync(
    resolve(evidence, "summary.json"),
    JSON.stringify(
      {
        passed: false,
        reason: error instanceof Error ? error.message : "rehearsal_failed",
        evidence,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  throw error;
} finally {
  if (mf) await mf.dispose();
}

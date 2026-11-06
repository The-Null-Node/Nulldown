import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type * as MiniflareModule from "miniflare";
import type { BranchMigrationChunk } from "../../shared/drop/branch-migration";

const root = realpathSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
);
const arg = (key: string) =>
  process.argv
    .find((value) => value.startsWith(`--${key}=`))
    ?.slice(key.length + 3);
const evidenceArg = arg("evidence");
assert.ok(evidenceArg, "Use --evidence=/absolute/new/evidence-directory");
const evidence = resolve(evidenceArg);
assert.ok(!existsSync(evidence), "Evidence path must be fresh");
mkdirSync(evidence, { recursive: false, mode: 0o700 });
mkdirSync(resolve(evidence, "tmp"), { mode: 0o700 });
const runId = arg("run-id") ?? `writer-${Date.now().toString(36)}`;
assert.match(
  runId,
  /^[A-Za-z0-9_-]{1,32}$/,
  "--run-id must be a bounded safe identifier",
);
const baseUrl = arg("base-url")?.replace(/\/$/, "");
const tokenFile = arg("token-file");
const tokenText = tokenFile
  ? readFileSync(resolve(tokenFile), "utf8").trim()
  : undefined;
const token =
  process.env.MIGRATION_REHEARSAL_TOKEN ??
  (tokenText?.startsWith("{")
    ? JSON.parse(tokenText).MIGRATION_REHEARSAL_TOKEN
    : tokenText) ??
  randomBytes(32).toString("base64url");
assert.ok(
  !baseUrl || tokenText || process.env.MIGRATION_REHEARSAL_TOKEN,
  "Hosted acceptance requires an explicitly supplied token",
);
if (baseUrl)
  assert.equal(
    new URL(baseUrl).protocol,
    "https:",
    "Hosted acceptance requires HTTPS",
  );
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const require = createRequire(resolve(root, "package.json"));
const runtimeRequire = createRequire(
  resolve(root, "node_modules/wrangler/package.json"),
);
const entry =
  "packages/nulldown-state-plane/test/migration-rehearsal.fixture.ts";
const esbuild = require("esbuild") as {
  build(
    options: Record<string, unknown>,
  ): Promise<{ metafile?: { inputs: Record<string, unknown> } }>;
};
const buildOptions = {
  absWorkingDir: root,
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["cloudflare:workers"],
  outfile: resolve(evidence, "writer-worker.mjs"),
  metafile: true,
};
const discovered = await esbuild.build({ ...buildOptions, write: false });
const migrations = [
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
];
const inputs = [
  ...new Set([
    ...Object.keys(discovered.metafile!.inputs),
    "scripts/state-plane/run-writer-acceptance.ts",
    "bun.lock",
    "packages/nulldown-state-plane/wrangler.migration-rehearsal.jsonc",
    "packages/nulldown-state-plane/migration-rehearsal-configuration.d.ts",
    ...migrations.map(
      (name, index) =>
        `migrations/${String(index + 1).padStart(4, "0")}_${name}`,
    ),
  ]),
].map((path) => ({ path, sha256: hash(readFileSync(resolve(root, path))) }));
writeFileSync(
  resolve(evidence, "source-pins-before-build.json"),
  JSON.stringify(inputs, null, 2),
  { mode: 0o600, flag: "wx" },
);
const compiled = await esbuild.build(buildOptions);
assert.deepEqual(
  Object.keys(compiled.metafile!.inputs).sort(),
  Object.keys(discovered.metafile!.inputs).sort(),
  "dependency graph changed during build",
);
for (const input of inputs)
  assert.equal(
    hash(readFileSync(resolve(root, input.path))),
    input.sha256,
    `source changed during compilation: ${input.path}`,
  );
const workerHash = hash(readFileSync(resolve(evidence, "writer-worker.mjs")));
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
      workerSha256: workerHash,
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
const nativeOptions: MiniflareModule.V4MiniflareOptions = {
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
        { type: "ESModule", path: resolve(evidence, "writer-worker.mjs") },
      ],
      compatibilityDate: "2026-09-02",
      bindings: { MIGRATION_REHEARSAL_TOKEN: token },
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
let mf = baseUrl
  ? undefined
  : new Miniflare(convertV4MiniflareOptions(nativeOptions));
let worker = mf ? await mf.getWorker("migration-rehearsal") : undefined;
const trace: Record<string, unknown>[] = [];
const target = { rootDropId: `MigrationRehearsal-${runId}`, branchId: "owner" };
const migrationId = `migration-rehearsal-${runId}`;
const request = async (
  action: string,
  values: Record<string, unknown> = {},
  targetOverride = target,
) => {
  const requestId = randomUUID();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const body = JSON.stringify({
    target: targetOverride,
    action,
    requestId,
    ...values,
  });
  try {
    const response = baseUrl
      ? await fetch(`${baseUrl}/fixture`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body,
          signal: AbortSignal.timeout(90000),
        })
      : await worker!.fetch("https://migration.invalid/fixture", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body,
          signal: AbortSignal.timeout(15000),
        });
    const text = await response.text();
    const row = {
      action,
      requestId,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: performance.now() - started,
      status: response.status,
      responseHash: hash(text),
      responseBytes: Buffer.byteLength(text),
      response: text,
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
    return {
      response,
      text,
      value: (() => {
        try {
          return JSON.parse(text).value;
        } catch {
          return undefined;
        }
      })(),
    };
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
const phase = async (
  action: string,
  values: Record<string, unknown> = {},
  targetOverride = target,
) => {
  const result = await request(action, values, targetOverride);
  assert.equal(result.response.status, 200, `${action}: ${result.text}`);
  return result.value;
};
const migrationsToApply = mf
  ? migrations.map(
      (name, index) => `${String(index + 1).padStart(4, "0")}_${name}`,
    )
  : [];
try {
  if (mf) {
    const db = await mf.getD1Database("LEGACY_D1", "migration-rehearsal");
    for (const file of migrationsToApply) {
      const sql = readFileSync(resolve(root, "migrations", file), "utf8")
        .replace(/^--.*$/gm, "")
        .replace(/CREATE TRIGGER[\s\S]*?END\s*;/gi, "");
      for (const statement of sql
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean))
        await db.prepare(statement).run();
    }
  }
  const app = async (
    path: string,
    method: "POST" | "GET" | "DELETE",
    expected: number,
    body?: unknown,
    selected = target,
    generation?: number,
  ) => {
    const result = await phase(
      "applicationRequest",
      { path, method, body, generation },
      selected,
    );
    assert.equal(
      result.status,
      expected,
      `${method} ${path}: ${JSON.stringify(result.body)}`,
    );
    return result.body;
  };
  const branchPath = `/api/branches/${target.rootDropId}/owner`;
  const certificate = { target, sourceGeneration: 0, migrationId };
  await phase("registerApplication");
  const resolved = await app(
    `/api/branches/resolve/${target.rootDropId}`,
    "POST",
    200,
  );
  assert.equal(resolved.created, true);
  assert.equal((await phase("sourceState")).active, 0);
  const initial =
    '# Writer acceptance\n\n```approval(id="approval-form")\nApprove?\n```\n';
  const event = (
    id: string,
    text: string,
    start: number,
    followsSeq: number,
    selected = target,
  ) => ({
    eventId: id,
    seq: -1,
    dropId: selected.rootDropId,
    sourceClientId: "writer-acceptance",
    createdAt: 1800000000000 + followsSeq + 1,
    metadata: { followsSeq },
    ops: [{ type: "insert", start, end: start, text }],
  });
  const first = event("writer-first", initial, 0, -1);
  const diffPath = `/api/diff/${target.rootDropId}?branchId=owner`;
  const accepted = await app(diffPath, "POST", 200, {
    version: 1,
    events: [first],
  });
  assert.equal(accepted.acknowledgements[0].status, "accepted");
  const duplicate = await app(diffPath, "POST", 200, {
    version: 1,
    events: [first],
  });
  assert.equal(duplicate.acknowledgements[0].status, "duplicate");
  assert.equal(duplicate.snapshotId, accepted.snapshotId);
  const source = {
    ...target,
    snapshotId: 1,
    sourceContentHash: `sha256:${createHash("sha256").update(`nulldown.source-content.v1\n${initial}`).digest("base64url")}`,
  };
  const stateFact = {
    version: 1,
    kind: "ui.state.patch",
    id: "writer-state",
    callId: "approval-form",
    createdAt: 1800000000100,
    source,
    patch: [{ op: "set", path: ["accepted"], value: true }],
  };
  await app("/api/nullplug/state", "POST", 200, stateFact);
  await app("/api/nullplug/submit", "POST", 200, {
    version: 1,
    kind: "ui.response",
    id: "writer-response",
    primitiveId: "approval-form",
    createdAt: 1800000000101,
    source,
    data: { approved: true },
  });
  await app(`${branchPath}/memory/facts`, "POST", 201, {
    recordId: "writer-memory",
    text: "Application fact",
  });
  await app(`${branchPath}/memory/procedures`, "POST", 201, {
    recordId: "writer-procedure",
    goal: "verify fenced writes",
    summary: "application procedure",
    steps: [],
  });
  await app(`${branchPath}/memory/facts`, "POST", 201, {
    recordId: "writer-delete",
    text: "delete this",
  });
  await app(`${branchPath}/memory/writer-delete`, "DELETE", 200);
  for (const operation of ["publish", "promote"])
    await app(`${branchPath}/${operation}`, "POST", 501, {
      expectedSnapshotId: 1,
      ...(operation === "publish"
        ? { expectedRevision: "sha256:placeholder" }
        : {}),
      idempotencyKey: `guard-${operation}`,
    });
  await app(`/api/delete/${target.rootDropId}`, "DELETE", 501);
  await app("/api/store", "POST", 501, {});
  await app(`${branchPath}/content`, "GET", 200);
  await app(`${branchPath}/memory/query?limit=100`, "GET", 200);
  const queryDurations: number[] = [];
  for (let index = 0; index < 8; index++) {
    const started = performance.now();
    const query = await app(
      `${branchPath}/resolved/query?q=Writer&top=3`,
      "GET",
      200,
    );
    assert.equal(query.stale, false);
    queryDurations.push(performance.now() - started);
  }
  writeFileSync(
    resolve(evidence, "query-measurements.json"),
    JSON.stringify(
      {
        boundary:
          "full authenticated fixture HTTP and real Pages resolved query; small synthetic document",
        firstMs: queryDurations[0],
        warmMs: queryDurations.slice(1),
        sourceHash: source.sourceContentHash,
      },
      null,
      2,
    ),
  );
  // A real CLI process talks HTTP through a local credential-isolating fixture
  // proxy. Its responses come exclusively from the actual Pages adapters.
  const cliTarget = {
    rootDropId: `MigrationRehearsal-${runId.slice(0, 27)}-cli`,
    branchId: "owner",
  };
  await phase("registerApplication", {}, cliTarget);
  await app(
    `/api/branches/resolve/${cliTarget.rootDropId}`,
    "POST",
    200,
    {},
    cliTarget,
  );
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(incoming) {
      const url = new URL(incoming.url);
      const result = await phase(
        "applicationRequest",
        {
          path: url.pathname + url.search,
          method: incoming.method,
          ...(incoming.method === "GET" ? {} : { body: await incoming.json() }),
        },
        cliTarget,
      );
      return new Response(
        typeof result.body === "string"
          ? result.body
          : JSON.stringify(result.body),
        { status: result.status, headers: result.headers },
      );
    },
  });
  try {
    const cli = async (args: string[]) => {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "run",
          "bin/nulldown.ts",
          ...args,
          `--base=http://127.0.0.1:${proxy.port}`,
          "--json",
        ],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOME: evidence,
            ND_CLIENT_ID: "writer-cli",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const deadline = setTimeout(() => child.kill(), 45000);
      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        assert.equal(exitCode, 0, stderr);
        appendFileSync(
          resolve(evidence, "cli-transcript.ndjson"),
          JSON.stringify({ args, exitCode, stdout, stderr }) + "\n",
        );
        return JSON.parse(stdout);
      } finally {
        clearTimeout(deadline);
      }
    };
    const args = [
      "diff",
      "apply",
      cliTarget.rootDropId,
      "--branch=owner",
      "--event-id=writer-cli-event",
      "--created-at=1800000000500",
      "--follows-seq=-1",
      "--insert=0:CLI writer",
    ];
    assert.equal((await cli(args)).accepted, 1);
    assert.equal((await cli(args)).deduplicated, 1);
    const cliContent = await cli([
      "branch",
      "content",
      cliTarget.rootDropId,
      "--branch=owner",
    ]);
    assert.equal(cliContent.content, "CLI writer");
  } finally {
    proxy.stop(true);
  }
  const concurrent = {
    rootDropId: `MigrationRehearsal-${runId.slice(0, 25)}-drain`,
    branchId: "owner",
  };
  await phase("registerApplication", {}, concurrent);
  await app(
    `/api/branches/resolve/${concurrent.rootDropId}`,
    "POST",
    200,
    {},
    concurrent,
  );
  await phase("applicationFault", { fault: "pause-admitted" }, concurrent);
  const concurrentDiff = `/api/diff/${concurrent.rootDropId}?branchId=owner`;
  const pending = app(
    concurrentDiff,
    "POST",
    200,
    {
      version: 1,
      events: [event("concurrent-admitted", "drained", 0, -1, concurrent)],
    },
    concurrent,
  );
  // Observe the real durable admission while the originating HTTP request is live.
  let active = 0;
  for (let attempt = 0; attempt < 40 && active === 0; attempt++)
    active = (await phase("sourceState", {}, concurrent)).active;
  assert.equal(active, 1);
  const concurrentCertificate = {
    target: concurrent,
    sourceGeneration: 0,
    migrationId: `migration-rehearsal-${concurrent.rootDropId.slice("MigrationRehearsal-".length)}`,
  };
  assert.equal(
    (
      await phase(
        "sourceFence",
        { certificate: concurrentCertificate },
        concurrent,
      )
    ).phase,
    "draining",
  );
  await app(
    concurrentDiff,
    "POST",
    409,
    {
      version: 1,
      events: [event("concurrent-rejected", "rejected", 0, -1, concurrent)],
    },
    concurrent,
  );
  await app(
    `/api/branches/${concurrent.rootDropId}/owner/memory/facts`,
    "POST",
    409,
    { text: "blocked during drain" },
    concurrent,
  );
  await phase("applicationRelease", {}, concurrent);
  await pending;
  assert.equal(
    (
      await phase(
        "sourceFence",
        { certificate: concurrentCertificate },
        concurrent,
      )
    ).phase,
    "frozen",
  );
  assert.equal(
    (
      await app(
        `/api/branches/${concurrent.rootDropId}/owner/content`,
        "GET",
        200,
        undefined,
        concurrent,
      )
    ).content,
    "drained",
  );
  // Freeze on admission closes new writers, while the admitted document and its
  // built-in memory snapshotter complete under the same permit.
  await phase("applicationFault", { fault: "freeze-admitted" });
  await app(diffPath, "POST", 200, {
    version: 1,
    events: [event("writer-second", "tail", initial.length, 0)],
  });
  assert.equal((await phase("sourceFence", { certificate })).phase, "frozen");
  await app(diffPath, "POST", 409, {
    version: 1,
    events: [event("writer-rejected", "!", initial.length + 4, 1)],
  });
  await app(`${branchPath}/memory/facts`, "POST", 409, { text: "rejected" });
  await app("/api/nullplug/state", "POST", 409, {
    ...stateFact,
    id: "writer-frozen",
  });
  const content = await app(`${branchPath}/content`, "GET", 200);
  assert.equal(content.content, initial + "tail");
  const prepared = await phase("prepareImport", {
    sourceGeneration: 0,
    migrationId,
  });
  const manifest = prepared.manifest;
  const chunks: BranchMigrationChunk[] = await Promise.all(
    Array.from({ length: prepared.chunkCount }, async (_, index) =>
      phase("preparedChunk", { migrationId, index }),
    ),
  );
  // In hosted runs, previously retained progress is valid evidence; fresh native runs
  // exercise durable partial-chunk recovery by reopening the same SQLite DO bundle.
  let progress = await phase("progress", { migrationId });
  for (let index = progress.nextChunk ?? 0; index < chunks.length; index++) {
    await phase("putChunk", {
      chunk: chunks[index],
      generation: manifest.generation,
    });
    if (!baseUrl && index === 0 && chunks.length > 1) {
      await mf!.dispose();
      mf = new Miniflare(convertV4MiniflareOptions(nativeOptions));
      worker = await mf.getWorker("migration-rehearsal");
      progress = await phase("progress", { migrationId });
      assert.equal(
        progress.nextChunk,
        1,
        "partial import cursor survives native restart",
      );
    }
  }
  if (progress.phase !== "verified" && progress.phase !== "activated")
    await phase("verify", {
      migrationId,
      generation: manifest.generation,
      certificate: { target, sourceGeneration: 0, migrationId },
    });
  await phase("transferSource", { migrationId, certificate });
  if (!baseUrl) {
    await mf!.dispose();
    mf = new Miniflare(convertV4MiniflareOptions(nativeOptions));
    worker = await mf.getWorker("migration-rehearsal");
  }
  await phase("activate", {
    migrationId,
    generation: manifest.generation,
    certificate,
  });

  const migrated = await phase("readback", { migrationId });
  assert.equal(migrated.content, content.content);
  assert.deepEqual(migrated.eventIds, ["writer-first", "writer-second"]);
  assert.deepEqual(migrated.runtimeIds.sort(), [
    "ui.response:approval-form:writer-response",
    "ui.state.patch:approval-form:writer-state",
  ]);
  assert.ok(migrated.memoryIds.includes("writer-memory"));
  assert.ok(migrated.memoryIds.includes("writer-procedure"));
  assert.ok(!migrated.memoryIds.includes("writer-delete"));
  const sourceRecords = chunks.flatMap((chunk) => chunk.payload);
  assert.deepEqual(
    migrated.events,
    sourceRecords
      .filter((row) => row.kind === "event")
      .map((row) => row.value.event),
  );
  assert.deepEqual(
    migrated.runtimeFacts,
    sourceRecords
      .filter((row) => row.kind === "runtime-fact")
      .map((row) => row.value),
  );
  assert.deepEqual(
    migrated.importedSnapshots,
    sourceRecords
      .filter((row) => row.kind === "snapshot")
      .map((row) => ({
        snapshot: row.value.snapshot,
        content: row.value.content,
      })),
  );
  const sortMemory = (records: { recordId: string }[]) =>
    [...records].sort((a, b) => a.recordId.localeCompare(b.recordId));
  assert.deepEqual(
    sortMemory(migrated.memoryRecords),
    sortMemory(
      sourceRecords
        .filter((row) => row.kind === "nullmem")
        .flatMap((row) => row.value.records),
    ),
  );
  assert.equal(migrated.memoryRevision, 0);
  const destination = async (
    path: string,
    method: string,
    expected: number,
    body?: unknown,
  ) => {
    const result = await phase("destinationRequest", { path, method, body });
    assert.equal(
      result.status,
      expected,
      `${method} destination ${path}: ${JSON.stringify(result.body)}`,
    );
    return result.body;
  };
  const destinationEvent = event(
    "destination-app",
    "!",
    content.content.length,
    1,
  );
  const destinationAccepted = await destination(diffPath, "POST", 200, {
    version: 1,
    events: [destinationEvent],
  });
  assert.equal(destinationAccepted.acknowledgements[0].status, "accepted");
  assert.equal(
    (
      await destination(diffPath, "POST", 200, {
        version: 1,
        events: [destinationEvent],
      })
    ).acknowledgements[0].status,
    "duplicate",
  );
  await destination(`${branchPath}/memory/facts`, "POST", 201, {
    recordId: "destination-memory",
    text: "destination application memory",
  });
  const destinationContent = content.content + "!";
  await destination("/api/nullplug/state", "POST", 200, {
    ...stateFact,
    id: "destination-state",
    source: {
      ...source,
      snapshotId: 3,
      sourceContentHash: `sha256:${createHash("sha256").update(`nulldown.source-content.v1\n${destinationContent}`).digest("base64url")}`,
    },
  });
  if (!baseUrl) {
    await mf!.dispose();
    mf = new Miniflare(convertV4MiniflareOptions(nativeOptions));
    worker = await mf.getWorker("migration-rehearsal");
  }
  assert.equal(
    (await destination(`${branchPath}/content`, "GET", 200)).content,
    destinationContent,
  );
  await app(diffPath, "POST", 409, { version: 1, events: [destinationEvent] });
  // Recovery must not mask a lost writer admission or completion: reconcile only
  // fixture-injected permits, then prove freeze progression and canonical outcomes.
  for (const fault of [
    "admission-lost",
    "completion-before",
    "completion-after",
  ] as const) {
    const isolatedId = `${runId.slice(0, 12)}-${fault.replaceAll("-", "")}`;
    const isolated = {
      rootDropId: `MigrationRehearsal-${isolatedId}`,
      branchId: "owner",
    };
    const isolatedMigration = `migration-rehearsal-${isolatedId}`;
    await phase(
      "registerApplication",
      { sourceGeneration: 0, migrationId: isolatedMigration },
      isolated,
    );
    await app(
      `/api/branches/resolve/${isolated.rootDropId}`,
      "POST",
      200,
      {},
      isolated,
    );
    await phase("applicationFault", { fault }, isolated);
    await app(
      `/api/branches/${isolated.rootDropId}/owner/memory/facts`,
      "POST",
      503,
      { recordId: "fault-fact", text: "fault probe" },
      isolated,
    );
    const before = await phase("sourceState", {}, isolated);
    assert.equal(before.active, fault === "completion-after" ? 0 : 1);
    const beforeFence = await phase(
      "sourceFence",
      {
        certificate: {
          target: isolated,
          sourceGeneration: 0,
          migrationId: isolatedMigration,
        },
      },
      isolated,
    );
    assert.equal(
      beforeFence.phase,
      fault === "completion-after" ? "frozen" : "draining",
    );
    if (!baseUrl) {
      await mf!.dispose();
      mf = new Miniflare(convertV4MiniflareOptions(nativeOptions));
      worker = await mf.getWorker("migration-rehearsal");
    }
    assert.equal(
      (await phase("sourceState", {}, isolated)).active,
      before.active,
    );
    await phase("reconcileApplication", {}, isolated);
    const fence = await request(
      "sourceFence",
      {
        certificate: {
          target: isolated,
          sourceGeneration: 0,
          migrationId: isolatedMigration,
        },
      },
      isolated,
    );
    assert.equal(fence.response.status, 200, fence.text);
  }

  // The persisted canonical root/branch must survive activation and reject writes
  // through the real handlers once freeze is reached.
  const state = await phase("sourceState", {});
  const assertions = [
    "durable gate precedes real branch creation",
    "real diff exact retry/content",
    "real runtime state and response facts",
    "real memory fact/procedure/delete",
    "root mutation exclusions",
    baseUrl
      ? "reconciled admission/completion uncertainty retains durable admission"
      : "reconciled admission/completion uncertainty survives restart",
    "admitted append and nested memory complete during drain",
    "post-freeze application writers rejected",
    "two-chunk and transfer-before-activation recovery",
    "exact migrated document/runtime/memory provenance",
  ];
  assert.ok(state, "source state evidence required");
  for (const input of inputs)
    assert.equal(
      hash(readFileSync(resolve(root, input.path))),
      input.sha256,
      `source changed during acceptance: ${input.path}`,
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
          ? "no in-run hosted restart; external redeployment verification required"
          : "Miniflare SQLite DO disposed and reopened during partial import and before activation",
        runId,
        target,
        migrationId,
        assertions,
        requestCount: trace.length,
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
        reason:
          error instanceof Error ? error.message : "writer_acceptance_failed",
        evidence,
        requestCount: trace.length,
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

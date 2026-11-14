import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type * as MiniflareModule from "miniflare";
import type * as EsbuildModule from "esbuild";
import type { BranchMigrationProgress } from "../../shared/drop/branch-migration";

const root = realpathSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
);
const arg = (key: string) =>
  process.argv
    .find((value) => value.startsWith(`--${key}=`))
    ?.slice(key.length + 3);
const evidenceArg = arg("evidence");
assert.ok(evidenceArg, "Use --evidence=/absolute/new/directory");
const evidence = resolve(evidenceArg);
assert.ok(
  !existsSync(evidence),
  "Preserve previous evidence; choose a fresh directory",
);
mkdirSync(evidence, { recursive: false, mode: 0o700 });
mkdirSync(resolve(evidence, "tmp"), { mode: 0o700 });
const baseUrl = arg("base-url");
const phase = arg("phase") ?? "all";
assert.ok(["all", "partial-import", "transferred", "finish"].includes(phase));
assert.ok(
  baseUrl || phase === "all",
  "Native acceptance runs all phases with storage reopen",
);
const runId = arg("run-id") ?? `authority-${Date.now().toString(36)}`;
assert.match(runId, /^[A-Za-z0-9_-]{1,28}$/);
if (baseUrl) assert.equal(new URL(baseUrl).protocol, "https:");
const tokenFile = arg("token-file");
const tokenText = tokenFile ? readFileSync(tokenFile, "utf8").trim() : "";
assert.ok(!baseUrl || tokenText, "Hosted runs require --token-file");
const token = tokenText
  ? tokenText.startsWith("{")
    ? (JSON.parse(tokenText).MIGRATION_REHEARSAL_TOKEN as string)
    : tokenText
  : randomBytes(32).toString("base64url");
assert.ok(token);
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const require = createRequire(resolve(root, "package.json"));
const runtimeRequire = createRequire(
  resolve(root, "node_modules/wrangler/package.json"),
);
const esbuild = require("esbuild") as typeof EsbuildModule;
const workerFile = resolve(evidence, "authority-worker.mjs");
const buildOptions: EsbuildModule.BuildOptions = {
  absWorkingDir: root,
  entryPoints: [
    "packages/nulldown-state-plane/test/migration-rehearsal.fixture.ts",
  ],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["cloudflare:workers"],
  outfile: workerFile,
  metafile: true,
};
const discovered = await esbuild.build({ ...buildOptions, write: false });
const migrations = readdirSync(resolve(root, "migrations"))
  .filter((name) => /^00(0[1-9]|1[0-5])_.*\.sql$/.test(name))
  .sort();
const inputs = [
  ...new Set([
    ...Object.keys(discovered.metafile!.inputs),
    "scripts/state-plane/run-authority-acceptance.ts",
    "bun.lock",
    "packages/nulldown-state-plane/wrangler.migration-rehearsal.jsonc",
    ...migrations.map((name) => `migrations/${name}`),
  ]),
].map((path) => ({ path, sha256: hash(readFileSync(resolve(root, path))) }));
await esbuild.build(buildOptions);
for (const input of inputs)
  assert.equal(
    hash(readFileSync(resolve(root, input.path))),
    input.sha256,
    `Changed during build: ${input.path}`,
  );
const workerSha256 = hash(readFileSync(workerFile));
writeFileSync(
  resolve(evidence, "source-pins.json"),
  JSON.stringify({ workerSha256, inputs }, null, 2),
);

type Checkpoint = {
  runId: string;
  workerSha256: string;
  stage: string;
  sourceContent: unknown;
  sourceMemory: unknown;
  sourceSnapshots: unknown;
  sourceFacts: unknown;
  progress: BranchMigrationProgress;
};
const resumePath = arg("resume");
let checkpoint: Checkpoint | undefined = resumePath
  ? (JSON.parse(readFileSync(resumePath, "utf8")) as Checkpoint)
  : undefined;
if (checkpoint) {
  assert.equal(checkpoint.runId, runId);
  assert.equal(
    checkpoint.workerSha256,
    workerSha256,
    "Recovery must use the same accepted bundle",
  );
}
if (["transferred", "finish"].includes(phase))
  assert.ok(checkpoint, "Recovery requires --resume=<prior checkpoint.json>");
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
      name: "authority-rehearsal",
      modulesRoot: evidence,
      modules: [{ type: "ESModule", path: workerFile }],
      compatibilityDate: "2026-09-02",
      bindings: {
        MIGRATION_REHEARSAL_TOKEN: token,
        ENVIRONMENT: "staging",
        STATE_PLANE_LOCAL_TEST: "0",
      },
      durableObjects: {
        REHEARSAL: {
          className: "MigrationRehearsalObject",
          useSQLite: true,
          unsafeUniqueKey: "migration-rehearsal-fixed16-v1",
        },
        BRANCH_STATE: {
          className: "BranchStateObject",
          useSQLite: true,
          unsafeUniqueKey: "authority-rehearsal-fixed16-v1",
        },
      },
      r2Buckets: { LEGACY_R2: "authority-source" },
      d1Databases: { LEGACY_D1: "authority-source" },
      outboundService() {
        throw Error("REHEARSAL_NETWORK_DISABLED");
      },
    },
  ],
};
let mf = baseUrl
  ? undefined
  : new Miniflare(convertV4MiniflareOptions(options));
let nativeUrl = mf ? String(await mf.ready) : undefined;
const target = { rootDropId: `MigrationRehearsal-${runId}`, branchId: "owner" };
const heldTarget = { ...target, rootDropId: `${target.rootDropId}-u` };
let checks = 0;
async function call<T = Record<string, unknown>>(
  action: string,
  values: Record<string, unknown> = {},
  selected = target,
  expected = 200,
): Promise<T> {
  const requestId = randomUUID();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const body = JSON.stringify({
    action,
    target: selected,
    requestId,
    ...values,
  });
  const init = {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body,
  };
  try {
    const response = await fetch(
      `${(baseUrl ?? nativeUrl!).replace(/\/$/, "")}/authority`,
      { ...init, keepalive: false, signal: AbortSignal.timeout(60000) },
    );
    const text = await response.text();
    appendFileSync(
      resolve(evidence, "request-journal.ndjson"),
      JSON.stringify({
        requestId,
        startedAt,
        action,
        path: values.path,
        target: selected,
        durationMs: performance.now() - started,
        status: response.status,
        response: text,
      }) + "\n",
    );
    assert.equal(response.status, expected, `${action}: ${text}`);
    checks++;
    const result = JSON.parse(text) as { value: T; error: string };
    return expected === 200 ? result.value : (result as T);
  } catch (error) {
    appendFileSync(
      resolve(evidence, "request-journal.ndjson"),
      JSON.stringify({
        requestId,
        startedAt,
        action,
        path: values.path,
        target: selected,
        durationMs: performance.now() - started,
        error: error instanceof Error ? error.message : "request_failed",
      }) + "\n",
    );
    throw error;
  }
}
type ApplicationResult = {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  duringAdmission?: {
    state: { phase: string; active: number };
    concurrentRejection: string;
  };
};
const branchPath = `/api/branches/${target.rootDropId}/owner`;
const diffPath = `/api/diff/${target.rootDropId}?branchId=owner`;
async function app(
  path: string,
  method = "GET",
  body?: unknown,
  expected = 200,
  extra: Record<string, unknown> = {},
) {
  const result = await call<ApplicationResult>("application", {
    path,
    method,
    body,
    ...extra,
  });
  assert.equal(
    result.status,
    expected,
    `${path}: ${JSON.stringify(result.body)}`,
  );
  return result;
}
const initial =
  '# Authority acceptance\n\n```approval(id="approval-form")\nApprove?\n```\n';
const event = (index: number, text: string, start: number) => ({
  eventId: `authority-event-${index}`,
  seq: -1,
  dropId: target.rootDropId,
  sourceClientId: "authority-acceptance",
  createdAt: 1800000000000 + index,
  metadata: { followsSeq: index - 1 },
  ops: [{ type: "insert", start, end: start, text }],
});
const finalSource = initial + "x".repeat(200) + "+";
async function reopen() {
  if (!mf) return;
  await mf.dispose();
  mf = new Miniflare(convertV4MiniflareOptions(options));
  nativeUrl = String(await mf.ready);
}
function save() {
  writeFileSync(
    resolve(evidence, "checkpoint.json"),
    JSON.stringify(checkpoint, null, 2),
  );
}

try {
  if (mf) {
    const db = await mf.getD1Database("LEGACY_D1", "authority-rehearsal");
    for (const file of migrations) {
      const sql = readFileSync(resolve(root, "migrations", file), "utf8")
        .replace(/^--.*$/gm, "")
        .replace(/CREATE TRIGGER[\s\S]*?END\s*;/gi, "");
      for (const statement of sql
        .split(";")
        .map((value) => value.trim())
        .filter(Boolean))
        await db.prepare(statement).run();
    }
  }
  if (["all", "partial-import"].includes(phase)) {
    assert.equal(
      (await call("select", {}, target, 404)).error,
      "branch_not_found",
    );
    await call("register");
    assert.equal(
      (await app(`/api/branches/resolve/${target.rootDropId}`, "POST", {})).body
        .created,
      true,
    );
    assert.equal((await call("select")).backend, "legacy");
    await app(
      `/api/diff/${target.rootDropId}?branchId=other`,
      "GET",
      undefined,
      409,
    );
    await app(
      `/api/branches/${target.rootDropId}/other/content`,
      "GET",
      undefined,
      409,
    );
    await app("/api/store", "POST", {}, 501);
    await app(diffPath, "POST", { version: 1, events: [event(0, initial, 0)] });
    const source = {
      ...target,
      snapshotId: 1,
      sourceContentHash: `sha256:${createHash("sha256").update(`nulldown.source-content.v1\n${initial}`).digest("base64url")}`,
    };
    await app("/api/nullplug/state", "POST", {
      version: 1,
      kind: "ui.state.patch",
      id: "authority-state",
      callId: "approval-form",
      createdAt: 1800000000300,
      source,
      patch: [{ op: "set", path: ["accepted"], value: true }],
    });
    for (let batch = 0; batch < 10; batch++)
      await app(diffPath, "POST", {
        version: 1,
        events: Array.from({ length: 20 }, (_, i) =>
          event(1 + batch * 20 + i, "x", initial.length + batch * 20 + i),
        ),
      });
    await app(
      `${branchPath}/memory/facts`,
      "POST",
      { recordId: "authority-memory", text: "preserve exact provenance" },
      201,
    );
    await app(
      `${branchPath}/memory/procedures`,
      "POST",
      {
        recordId: "authority-procedure",
        goal: "recover migration",
        summary: "Resume from durable progress",
        steps: [],
      },
      201,
    );
    const admitted = await app(
      diffPath,
      "POST",
      { version: 1, events: [event(201, "+", initial.length + 200)] },
      200,
      { fault: "freeze-admitted" },
    );
    assert.deepEqual(admitted.duringAdmission, {
      state: {
        target,
        generation: 0,
        phase: "draining",
        migrationId: `authority-${runId}`,
        active: 1,
      },
      concurrentRejection: "routing_placement_mismatch",
    });
    await app(
      diffPath,
      "POST",
      { version: 1, events: [event(202, "denied", finalSource.length)] },
      409,
    );
    assert.equal((await call("freeze")).phase, "frozen");
    const content = (await app(`${branchPath}/content`)).body;
    assert.equal(content.content, finalSource);
    const memory = (await app(`${branchPath}/memory/query?limit=100`)).body;
    assert.ok(Array.isArray(memory.records) && memory.records.length >= 2);
    const snapshots = (await app(`${branchPath}/snapshots`)).body;
    const facts = (
      await app(`${diffPath}&cursor=-1&limit=1&factCursor=-1&factLimit=100`)
    ).body.facts;
    assert.ok(Array.isArray(facts) && facts.length === 1);
    const progress = await call<BranchMigrationProgress>("prepare");
    assert.ok(progress.chunkCount >= 2, "Fixture must exercise partial import");
    const partial = await call<BranchMigrationProgress>("import", { index: 0 });
    assert.equal(partial.nextChunk, 1);
    assert.deepEqual(await call("import", { index: 0 }), partial);
    await call("register", {}, heldTarget);
    await call("hold", {}, heldTarget);
    assert.equal((await call("freeze", {}, heldTarget)).phase, "draining");
    checkpoint = {
      runId,
      workerSha256,
      stage: "partial-import",
      sourceContent: content,
      sourceMemory: memory,
      sourceSnapshots: snapshots,
      sourceFacts: facts,
      progress: partial,
    };
    save();
  }
  if (["all", "transferred"].includes(phase)) {
    assert.equal(checkpoint!.stage, "partial-import");
    await reopen();
    assert.deepEqual(await call("progress"), checkpoint!.progress);
    assert.equal((await call("source", {}, heldTarget)).active, 1);
    assert.deepEqual(
      (await app(`${branchPath}/content`)).body,
      checkpoint!.sourceContent,
    );
    assert.deepEqual(await call("import", { index: 0 }), checkpoint!.progress);
    for (
      let index = checkpoint!.progress.nextChunk;
      index < checkpoint!.progress.chunkCount;
      index++
    )
      await call("import", { index });
    await call("verify");
    const delayed = await app(`${branchPath}/content`, "GET", undefined, 409, {
      fault: "transfer-before-read-validation",
    });
    assert.equal(delayed.body.code, "routing_placement_mismatch");
    checkpoint!.progress = await call<BranchMigrationProgress>("transfer");
    assert.deepEqual(await call("verify"), checkpoint!.progress);
    assert.equal((await call("select")).backend, "transition");
    await app(`${branchPath}/content`, "GET", undefined, 409);
    assert.equal(
      (await call("abort", {}, target, 409)).error,
      "routing_placement_mismatch",
    );
    checkpoint!.stage = "transferred";
    save();
  }
  if (["all", "finish"].includes(phase)) {
    assert.equal(checkpoint!.stage, "transferred");
    await reopen();
    assert.equal((await call("select")).backend, "transition");
    assert.equal(
      (await call("staleAdmission", {}, target, 409)).error,
      "routing_placement_mismatch",
    );
    assert.equal((await call("source", {}, heldTarget)).active, 1);
    await call("completeHeld", {}, heldTarget);
    assert.equal((await call("freeze", {}, heldTarget)).phase, "frozen");
    assert.equal((await call("abort", {}, heldTarget)).generation, 1);
    assert.equal(
      (await call("staleAdmission", {}, heldTarget, 409)).error,
      "routing_placement_mismatch",
    );
    await call("transfer");
    const activated = await call<BranchMigrationProgress>("activate");
    assert.deepEqual(await call("activate"), activated);
    assert.equal((await call("select")).backend, "state-plane");
    await app(`${branchPath}/content`, "GET", undefined, 503, {
      fault: "destination-unavailable",
    });
    await app(
      `/api/branches/${target.rootDropId}/other/content`,
      "GET",
      undefined,
      409,
    );
    assert.deepEqual(
      (await app(`${branchPath}/content`)).body,
      checkpoint!.sourceContent,
    );
    assert.deepEqual(
      (await app(`${branchPath}/snapshots`)).body,
      checkpoint!.sourceSnapshots,
    );
    const memory = (await app(`${branchPath}/memory/query?limit=100`)).body;
    assert.deepEqual(
      memory.records,
      (checkpoint!.sourceMemory as Record<string, unknown>).records,
    );
    assert.deepEqual(
      (await app(`${diffPath}&cursor=-1&limit=1&factCursor=-1&factLimit=100`))
        .body.facts,
      checkpoint!.sourceFacts,
    );
    const duplicate = await app(diffPath, "POST", {
      version: 1,
      events: [event(201, "+", initial.length + 200)],
    });
    assert.equal(duplicate.body.deduplicated, 1);
    const next = event(202, "destination", finalSource.length);
    await app(diffPath, "POST", { version: 1, events: [next] });
    assert.equal(
      (await app(diffPath, "POST", { version: 1, events: [next] })).body
        .deduplicated,
      1,
    );
    await app(
      `${branchPath}/memory/facts`,
      "POST",
      { recordId: "authority-post", text: "destination write" },
      201,
    );
    const query = await app(`${branchPath}/resolved/query?q=Authority&top=3`);
    assert.equal(query.body.stale, false);
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(incoming) {
        const url = new URL(incoming.url);
        const response = await call<ApplicationResult>("application", {
          path: url.pathname + url.search,
          method: incoming.method,
          ...(incoming.method === "GET" ? {} : { body: await incoming.json() }),
        });
        return new Response(
          typeof response.body === "string"
            ? response.body
            : JSON.stringify(response.body),
          { status: response.status, headers: response.headers },
        );
      },
    });
    try {
      const args = [
        "branch",
        "content",
        target.rootDropId,
        "--branch=owner",
        `--base=http://127.0.0.1:${proxy.port}`,
        "--json",
      ];
      const child = Bun.spawn(
        [process.execPath, "--no-env-file", "run", "bin/nulldown.ts", ...args],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOME: evidence,
            ND_CLIENT_ID: "authority-cli",
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
        writeFileSync(
          resolve(evidence, "cli.json"),
          JSON.stringify({ args, stdout, stderr, exitCode }, null, 2),
        );
        assert.equal(exitCode, 0, stderr);
        assert.equal(JSON.parse(stdout).content, finalSource + "destination");
      } finally {
        clearTimeout(deadline);
      }
    } finally {
      proxy.stop(true);
    }
    await reopen();
    assert.equal(
      (await app(`${branchPath}/content`)).body.content,
      finalSource + "destination",
    );
    checkpoint!.stage = "complete";
    checkpoint!.progress = activated;
    save();
  }
  writeFileSync(
    resolve(evidence, "result.json"),
    JSON.stringify(
      {
        passed: true,
        checks,
        runId,
        phase,
        workerSha256,
        hosted: Boolean(baseUrl),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, checks, runId, phase, evidence }));
} finally {
  await mf?.dispose();
}

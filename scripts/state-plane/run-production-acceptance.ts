import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type * as MiniflareModule from "miniflare";
import type * as EsbuildModule from "esbuild";
import type { BranchMigrationProgress } from "../../shared/drop/branch-migration";
import type { BranchStateRpcResult } from "../../packages/nulldown-state-plane/src/shard-router";

const root = process.cwd();
const evidenceArg = process.argv
  .find((arg) => arg.startsWith("--evidence="))
  ?.slice(11);
assert.ok(evidenceArg, "Specify a fresh --evidence=directory");
const evidence = resolve(evidenceArg);
mkdirSync(evidence, { recursive: false, mode: 0o700 });
mkdirSync(resolve(evidence, "tmp"));
const require = createRequire(resolve(root, "package.json"));
const runtimeRequire = createRequire(
  resolve(root, "node_modules/wrangler/package.json"),
);
const { build } = require("esbuild") as typeof EsbuildModule;
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = runtimeRequire(
  "miniflare",
) as typeof MiniflareModule;
const files = [
  "src/production-worker.ts",
  "test/production-ingress.fixture.ts",
];
for (const [index, file] of files.entries()) {
  const outfile = resolve(evidence, `worker-${index}.mjs`);
  const result = await build({
    entryPoints: [resolve(root, "packages/nulldown-state-plane", file)],
    outfile,
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    external: ["cloudflare:workers"],
    metafile: true,
  });
  writeFileSync(
    resolve(evidence, `pins-${index}.json`),
    JSON.stringify(
      {
        bundleSha256: createHash("sha256")
          .update(readFileSync(outfile))
          .digest("hex"),
        inputs: [
          ...Object.keys(result.metafile!.inputs),
          "scripts/state-plane/run-production-acceptance.ts",
          "packages/nulldown-state-plane/wrangler.production.jsonc",
          "wrangler.toml",
        ].map((path) => ({
          path,
          sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
        })),
      },
      null,
      2,
    ),
  );
}
const target = { rootDropId: "1rIbFszcNmrt", branchId: "owner" };
const certificate = {
  target,
  sourceGeneration: 0,
  migrationId: "production-native-v1",
};
const options: MiniflareModule.V4MiniflareOptions = {
  rootPath: root,
  modulesRoot: evidence,
  resourceTmpPath: resolve(evidence, "tmp"),
  resourcePersistencePath: resolve(evidence, "state"),
  host: "127.0.0.1",
  port: 0,
  cf: false,
  telemetry: { enabled: false },
  log: new Log(LogLevel.ERROR),
  workers: [
    {
      name: "application",
      modules: [{ type: "ESModule", path: resolve(evidence, "worker-1.mjs") }],
      compatibilityDate: "2026-09-02",
      bindings: {
        STATE_PLANE_CANARY_ROOT: target.rootDropId,
        ACCOUNT_AUTH_SECRET: "production-fixture-only",
        PROVIDER_ENCRYPTION_PRIVATE_JWK: "configured",
        PROVIDER_SIGNING_PRIVATE_JWK: "configured",
        LOG_LEVEL: "silent",
      },
      serviceBindings: {
        STATE_PLANE: { name: "state-plane", entrypoint: "BranchStateService" },
        MIGRATION: {
          name: "state-plane",
          entrypoint: "BranchMigrationService",
        },
      },
      r2Buckets: { R2_BUCKET: "production-fixture" },
      d1Databases: { DB: "production-fixture" },
      outboundService() {
        throw Error("NETWORK_DISABLED");
      },
    },
    {
      name: "state-plane",
      modules: [{ type: "ESModule", path: resolve(evidence, "worker-0.mjs") }],
      compatibilityDate: "2026-09-02",
      bindings: {
        ENVIRONMENT: "production",
        STATE_PLANE_LOCAL_TEST: "0",
        STATE_PLANE_CANARY_ROOT: target.rootDropId,
        STATE_PLANE_OUTBOX_ENABLED: "0",
      },
      durableObjects: {
        BRANCH_STATE: {
          className: "BranchStateObject",
          useSQLite: true,
          unsafeUniqueKey: "production-native-fixed16-v1",
        },
      },
      r2Buckets: { LEGACY_R2: "production-fixture" },
      d1Databases: { LEGACY_D1: "production-fixture" },
      outboundService() {
        throw Error("NETWORK_DISABLED");
      },
    },
  ],
};
let mf = new Miniflare(convertV4MiniflareOptions(options));
const transcript: unknown[] = [];
let token = "";
async function app<T = unknown>(
  path: string,
  body?: unknown,
  status = 200,
): Promise<T> {
  const response = await mf.dispatchFetch(`https://production.invalid${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-nulldown-client-id": "production-fixture",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  transcript.push({ path, status: response.status, value });
  assert.equal(response.status, status, JSON.stringify(value));
  return value as T;
}
async function control<T = unknown>(
  command: object,
  error?: string,
): Promise<T | undefined> {
  const result = await app<BranchStateRpcResult<T>>("/__control", command);
  assert.equal(result.ok, !error, JSON.stringify(result));
  if (!result.ok) {
    assert.equal(result.error.code, error);
    return;
  }
  return result.value;
}
const migrate = (operation: string, extra = {}, error?: string) =>
  control<BranchMigrationProgress>({ operation, certificate, ...extra }, error);
const branchPath = `/api/branches/${target.rootDropId}/owner`;
try {
  await mf.ready;
  const db = await mf.getD1Database("DB", "application");
  for (const file of readdirSync(resolve(root, "migrations"))
    .filter((name) => /^00(0[1-9]|1[0-5])_.*\.sql$/.test(name))
    .sort()) {
    const sql = readFileSync(resolve(root, "migrations", file), "utf8")
      .replace(/^--.*$/gm, "")
      .replace(/CREATE TRIGGER[\s\S]*?END\s*;/gi, "");
    for (const statement of sql
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean))
      await db.prepare(statement).run();
  }
  const bucket = await mf.getR2Bucket("R2_BUCKET", "application");
  await bucket.put(
    target.rootDropId,
    JSON.stringify({
      content: "production native canary\n",
      metadata: { ownerAccountId: "production-fixture-owner" },
    }),
    { httpMetadata: { contentType: "application/json" } },
  );
  token = (
    (await (
      await mf.dispatchFetch("https://fixture.invalid/__token")
    ).json()) as { token: string }
  ).token;
  await control(
    { operation: "register", target: { ...target, branchId: "other" } },
    "routing_placement_mismatch",
  );
  await control(
    {
      operation: "register",
      target: { ...target, rootDropId: "OtherRoot123" },
    },
    "routing_placement_mismatch",
  );
  await control({ operation: "register", target });
  await control(
    {
      operation: "freeze",
      target,
      certificate: { ...certificate, target: { ...target, branchId: "other" } },
    },
    "invalid_command",
  );
  await control(
    {
      operation: "prepare",
      certificate: { ...certificate, target: { ...target, branchId: "other" } },
    },
    "routing_placement_mismatch",
  );
  await app(`/api/branches/resolve/${target.rootDropId}`, {});
  const before = await app(`${branchPath}/content`);
  await app(`/api/delete/${target.rootDropId}`, {}, 501);
  await app(`/api/branches/${target.rootDropId}/other/content`, undefined, 409);
  await migrate("freeze");
  const progress = await migrate("prepare");
  assert.ok(progress);
  await migrate("import", { index: -1 }, "invalid_command");
  for (let index = 0; index < progress.chunkCount; index++)
    await migrate("import", { index });
  await migrate("verify");
  await mf.dispose();
  mf = new Miniflare(convertV4MiniflareOptions(options));
  await mf.ready;
  await migrate("progress");
  assert.deepEqual(await app(`${branchPath}/content`), before);
  await migrate("transfer");
  await migrate("abort", {}, "routing_placement_mismatch");
  await app(`${branchPath}/content`, undefined, 409);
  await mf.dispose();
  mf = new Miniflare(convertV4MiniflareOptions(options));
  await mf.ready;
  await migrate("activate");
  assert.deepEqual(await app(`${branchPath}/content`), before);
  assert.deepEqual(await app(`/api/branches/1rIbFs/owner/content`), before);
  await app(
    `${branchPath}/memory/facts`,
    {
      recordId: "production-native-fact",
      text: "destination write verification",
    },
    201,
  );
  const memory = await app<{ records: { recordId: string }[] }>(
    `${branchPath}/memory/query?kind=fact&q=destination%20write%20verification`,
  );
  assert.ok(
    memory.records.some(
      (record: { recordId: string }) =>
        record.recordId === "production-native-fact",
    ),
  );
  writeFileSync(
    resolve(evidence, "result.json"),
    JSON.stringify(
      { passed: true, requests: transcript.length, transcript },
      null,
      2,
    ),
  );
  console.log(
    `Production native acceptance passed: ${transcript.length} requests`,
  );
} finally {
  writeFileSync(
    resolve(evidence, "transcript.json"),
    JSON.stringify(transcript, null, 2),
  );
  await mf.dispose();
}

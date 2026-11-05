import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const requested = process.argv
  .find((arg) => arg.startsWith("--evidence="))
  ?.slice(11);
const sizeArg = process.argv.find((arg) => arg.startsWith("--size="))?.slice(7);
if (sizeArg && ![8192, 65536, 262144].includes(Number(sizeArg)))
  throw Error(
    "Usage: run-migration-benchmark.ts [--size=8192|65536|262144] [--evidence=<fresh directory>]",
  );
const evidence = requested
  ? resolve(requested)
  : mkdtempSync(join(tmpdir(), "nulldown-migration-bench-"));
mkdirSync(evidence, { recursive: true });
if (readdirSync(evidence).length)
  throw Error("Evidence directory must be empty");
mkdirSync(join(evidence, "temp"));
mkdirSync(join(evidence, "empty-home"));
const hashFile = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const entry = "packages/nulldown-state-plane/src/worker.ts";
const worker = await Bun.build({
  entrypoints: [join(root, entry)],
  naming: "state-worker.mjs",
  target: "browser",
  format: "esm",
  external: ["cloudflare:workers"],
  metafile: true,
});
if (!worker.success)
  throw new AggregateError(worker.logs, "Worker build failed");
const benchmarkWorker = await Bun.build({
  entrypoints: [
    join(
      root,
      "packages/nulldown-state-plane/test/migration-benchmark-worker.fixture.ts",
    ),
  ],
  naming: "benchmark-worker.mjs",
  target: "browser",
  format: "esm",
  external: ["cloudflare:workers"],
  metafile: true,
});
if (!benchmarkWorker.success)
  throw new AggregateError(
    benchmarkWorker.logs,
    "Benchmark Worker build failed",
  );
const driver = await Bun.build({
  entrypoints: [join(root, "scripts/state-plane/migration-benchmark.ts")],
  naming: "migration-benchmark.mjs",
  target: "node",
  external: ["miniflare"],
  metafile: true,
});
if (!driver.success)
  throw new AggregateError(driver.logs, "Benchmark build failed");
const pinnedPaths = new Set([
  ...Object.keys(worker.metafile!.inputs),
  ...Object.keys(benchmarkWorker.metafile!.inputs),
  ...Object.keys(driver.metafile!.inputs),
  "scripts/state-plane/run-migration-benchmark.ts",
  "package.json",
  "bun.lock",
  ...Array.from(
    { length: 15 },
    (_, index) =>
      `migrations/${String(index + 1).padStart(4, "0")}_${
        [
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
        ][index]
      }`,
  ),
]);
const inputs = Object.fromEntries(
  [...pinnedPaths].map((path) => {
    const absolute = realpathSync(resolve(root, path));
    if (!absolute.startsWith(realpathSync(root) + "/"))
      throw Error(`Mixed benchmark source tree: ${absolute}`);
    return [absolute, hashFile(absolute)];
  }),
);
const verifySources = () => {
  for (const [path, digest] of Object.entries(inputs))
    if (hashFile(path) !== digest)
      throw Error(`Source changed during compilation: ${path}`);
};
writeFileSync(
  join(evidence, "source-pins-before-build.json"),
  JSON.stringify(inputs, null, 2),
);
const builds = [
  {
    entry,
    naming: "state-worker.mjs",
    target: "browser" as const,
    external: ["cloudflare:workers"],
    discovery: worker,
  },
  {
    entry:
      "packages/nulldown-state-plane/test/migration-benchmark-worker.fixture.ts",
    naming: "benchmark-worker.mjs",
    target: "browser" as const,
    external: ["cloudflare:workers"],
    discovery: benchmarkWorker,
  },
  {
    entry: "scripts/state-plane/migration-benchmark.ts",
    naming: "migration-benchmark.mjs",
    target: "node" as const,
    external: ["miniflare"],
    discovery: driver,
  },
];
for (const build of builds) {
  verifySources();
  const result = await Bun.build({
    entrypoints: [join(root, build.entry)],
    naming: build.naming,
    target: build.target,
    external: build.external,
    format: "esm",
    outdir: evidence,
    metafile: true,
  });
  if (!result.success)
    throw new AggregateError(result.logs, "Pinned benchmark build failed");
  if (
    JSON.stringify(Object.keys(result.metafile!.inputs).sort()) !==
    JSON.stringify(Object.keys(build.discovery.metafile!.inputs).sort())
  )
    throw Error("Benchmark dependency graph changed during compilation");
  verifySources();
}
writeFileSync(
  join(evidence, "source-pins.json"),
  JSON.stringify(
    {
      bunVersion: Bun.version,
      inputs,
      workerDependencies: worker.metafile!.inputs,
      benchmarkWorkerDependencies: benchmarkWorker.metafile!.inputs,
      driverDependencies: driver.metafile!.inputs,
      protocol: "discover-discard-pin-compile-verify-v1",
    },
    null,
    2,
  ),
);
const artifacts = [
  join(evidence, "state-worker.mjs"),
  join(evidence, "benchmark-worker.mjs"),
  join(evidence, "migration-benchmark.mjs"),
];
const artifactPins = Object.fromEntries(
  artifacts.map((path) => [path, hashFile(path)]),
);
writeFileSync(
  join(evidence, "bundle-pins.json"),
  JSON.stringify(artifactPins, null, 2),
);
for (const [path, digest] of Object.entries(inputs))
  if (hashFile(path) !== digest)
    throw Error(`Source changed after pinning: ${path}`);
const child = Bun.spawn(
  [
    "node",
    join(evidence, "migration-benchmark.mjs"),
    `--root=${root}`,
    `--evidence=${evidence}`,
    ...(sizeArg ? [`--size=${sizeArg}`] : []),
  ],
  {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: join(evidence, "empty-home"),
      TMPDIR: join(evidence, "temp"),
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_WRITE_LOGS: "false",
    },
    stdout: "inherit",
    stderr: "inherit",
    signal: AbortSignal.timeout(600_000),
  },
);
const code = await child.exited;
for (const [path, digest] of Object.entries(artifactPins))
  if (hashFile(path) !== digest)
    throw Error(`Pinned bundle changed during run: ${path}`);
process.exitCode = code;

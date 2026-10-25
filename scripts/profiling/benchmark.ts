/** Local elapsed-time instrumentation microbenchmark; no credentials or external I/O. */
import { createTiming } from "../../functions/api/_lib/core/observability/profiling";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
const directory = resolve(import.meta.dir, "../../.profiling");
mkdirSync(directory, { recursive: true });
const root = resolve(import.meta.dir, "../..");
const protocol = JSON.parse(
  readFileSync(resolve(import.meta.dir, "PROTOCOL.json"), "utf8"),
);
const sealName =
  process.argv.find((s) => s.startsWith("--seal="))?.slice(7) ??
  "premeasurement-001.json";
if (!/^premeasurement-[0-9]{3}\.json$/.test(sealName))
  throw Error("Invalid seal filename");
const digest = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");
const freezeBytes = readFileSync(resolve(directory, sealName)),
  freeze = JSON.parse(freezeBytes.toString("utf8"));
if (
  digest(freezeBytes) !==
  readFileSync(resolve(directory, sealName + ".sha256"), "utf8")
    .trim()
    .split(/\s+/)[0]
)
  throw Error("Invalid premeasurement seal");
for (const [path, hash] of Object.entries(freeze.files))
  if (digest(readFileSync(resolve(root, path))) !== hash)
    throw Error("Frozen measurement source changed");
for (const [path, hash] of Object.entries(freeze.rootLocks))
  if (digest(readFileSync(resolve(path))) !== hash)
    throw Error("Root dependency lock changed");
const request = new Request("https://local.invalid/");
const samples: {
  mode: string;
  label: string;
  ms: number;
  operations: number;
}[] = [];
const tasks: Promise<unknown>[] = [];
function measure(mode: string, label: string) {
  const start = performance.now();
  const h = createTiming(
    request,
    {
      STAGING_TELEMETRY_ENABLED: "1",
      STAGING_TELEMETRY_ENVIRONMENT: "staging",
      STAGING_PROFILING_MODE: mode,
      STAGING_PROFILING_SAMPLE_PERMILLE: "1000",
      TELEMETRY: { fetch: async () => new Response(null, { status: 204 }) },
    },
    (p) => tasks.push(p),
    "request.diff",
  );
  for (let i = 0; i < 128; i++) h.timing.sync("append.hash", () => i + 1);
  h.finish(200);
  samples.push({ mode, label, ms: performance.now() - start, operations: 128 });
}
// One first-use observation per mode is labelled cold, never pooled with warm.
for (const mode of ["off", "summary", "detailed"])
  measure(mode, "cold-first-use-host-process");
await Promise.all(tasks.splice(0));
for (let round = 0; round < 100; round++) {
  for (const mode of ["off", "summary", "detailed"]) measure(mode, "warmup");
  await Promise.all(tasks.splice(0));
}
// Rotating order limits systematic JIT/thermal/order bias.1000 warm samples/mode.
const modes = ["off", "summary", "detailed"];
for (let round = 0; round < 1000; round++) {
  for (let i = 0; i < 3; i++) measure(modes[(round + i) % 3], "warm");
  await Promise.all(tasks.splice(0));
}
const quantile = (values: number[], q: number) =>
  values.slice().sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
const stats = Object.fromEntries(
  modes.map((mode) => {
    const values = samples
      .filter((s) => s.mode === mode && s.label === "warm")
      .map((s) => s.ms);
    return [
      mode,
      {
        count: values.length,
        p50Ms: quantile(values, 0.5),
        p95Ms: quantile(values, 0.95),
      },
    ];
  }),
);
const sourceHashes = Object.fromEntries(
  [
    "functions/api/_lib/core/observability/profiling.ts",
    "shared/observability/profiling.ts",
    "scripts/profiling/README.md",
    "scripts/profiling/benchmark.ts",
  ].map((path) => [
    path,
    createHash("sha256")
      .update(readFileSync(resolve(root, path)))
      .digest("hex"),
  ]),
);
const budget = Object.fromEntries(
  ["summary", "detailed"].map((mode) => {
    const added = stats[mode].p95Ms - stats.off.p95Ms,
      limit = protocol.cpuProxyBudgetMs[mode];
    return [
      mode,
      {
        addedP95Ms: added,
        absoluteLimitMs: limit,
        relativeApplicable:
          stats.off.p95Ms >= protocol.cpuProxyRelativeBaselineMs,
        pass:
          added <= limit &&
          (stats.off.p95Ms < protocol.cpuProxyRelativeBaselineMs ||
            added / stats.off.p95Ms <= protocol.cpuProxyRelativeLimit),
      },
    ];
  }),
);
writeFileSync(
  resolve(directory, "benchmark-samples.jsonl"),
  samples.map((s) => JSON.stringify(s)).join("\n") + "\n",
);
const report = {
  runtime: Bun.version,
  platform: process.platform,
  arch: process.arch,
  measurement:
    "host elapsed instrumentation+serialization; excludes asynchronous send; not workerd CPU or product latency",
  premeasurement: sealName,
  premeasurementSha256: digest(freezeBytes),
  protocolSha256: freeze.protocolSha256,
  sourceHashes,
  config: {
    operations: 128,
    samplePermille: 1000,
    warmup: 100,
    warmSamples: 1000,
  },
  stats,
  budget,
};
writeFileSync(
  resolve(directory, "benchmark.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));

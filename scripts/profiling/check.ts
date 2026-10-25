import { resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { captureChild } from "./capture";

const root = resolve(import.meta.dir, "../.."),
  out = resolve(root, ".profiling");
mkdirSync(resolve(out, "empty-home"), { recursive: true });
const env: Record<string, string> = {
  PATH: process.env.PATH!,
  HOME: resolve(out, "empty-home"),
  CI: "true",
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_WRITE_LOGS: "false",
};
if (process.env.MINIFLARE_WORKERD_PATH)
  env.MINIFLARE_WORKERD_PATH = process.env.MINIFLARE_WORKERD_PATH;
const records: unknown[] = [];
async function run(name: string, args: string[]) {
  const at = performance.now(),
    child = Bun.spawn(args, { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const { stdout, stderr, exit } = await captureChild(child);
  const log = stdout + stderr;
  writeFileSync(resolve(out, name + ".log"), log);
  records.push({
    name,
    args,
    exit,
    ms: performance.now() - at,
    logSha256: createHash("sha256").update(log).digest("hex"),
  });
  writeFileSync(
    resolve(out, "commands.json"),
    JSON.stringify(records, null, 2) + "\n",
  );
  if (exit !== 0) throw Error(`${name} failed: see .profiling/${name}.log`);
  return stdout;
}
const tests = Array.from(
  new Bun.Glob("scripts/profiling/tests/*.spec.ts").scanSync({ cwd: root }),
);
await run("profiling-types", ["bun", "run", "typecheck:profiling"]);
await run("collector-types", ["bun", "run", "typecheck:telemetry"]);
await run("unit", ["bun", "test", ...tests]);
await run("build", ["bun", "run", "scripts/profiling/build.ts"]);
const seal = (
  await run("freeze", ["bun", "run", "scripts/profiling/freeze.ts"])
).trim();
if (!/^premeasurement-\d{3}\.json$/.test(seal))
  throw Error("Unexpected snapshot filename");
const sha = await run("independent-seal", [
  "shasum",
  "-a",
  "256",
  resolve(out, seal),
]);
writeFileSync(resolve(out, seal + ".sha256"), sha, { flag: "wx" });
const benchmark = process.argv.includes("--benchmark");
await run("native", [
  "node",
  "scripts/profiling/tests/authenticated-route.mjs",
  `--seal=${seal}`,
  ...(benchmark ? ["--benchmark"] : []),
]);
if (benchmark) {
  await run("host-proxy", [
    "bun",
    "run",
    "scripts/profiling/benchmark.ts",
    `--seal=${seal}`,
  ]);
  for (const file of ["authenticated-benchmark.json", "benchmark.json"]) {
    const r = JSON.parse(readFileSync(resolve(out, file), "utf8"));
    if (
      !Object.values(r.budget).every(
        (b) =>
          typeof b === "object" && b !== null && "pass" in b && b.pass === true,
      )
    )
      throw Error(
        "Frozen local budget failed; retain samples and do not relax thresholds",
      );
  }
}
console.log(
  JSON.stringify({
    passed: true,
    benchmark,
    seal,
    output: ".profiling",
    deployment: false,
  }),
);

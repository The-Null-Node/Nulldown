import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../.."),
  out = resolve(root, ".profiling");
mkdirSync(out, { recursive: true });
const sha = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");
const runtime = process.env.MINIFLARE_WORKERD_PATH;
if (!runtime || !existsSync(runtime))
  throw Error(
    "Set MINIFLARE_WORKERD_PATH to an approved workerd binary supporting the collector compatibility date; no dependency is upgraded automatically.",
  );
const files: Record<string, string> = {};
for (const pattern of [
  "functions/**/*.ts",
  "shared/**/*.ts",
  "src/server/**/*.ts",
  "scripts/profiling/**/*.{ts,mjs,json,cjs,md}",
  "packages/nulldown-telemetry/**/*.{ts,json,jsonc}",
]) {
  for await (const path of new Bun.Glob(pattern).scan({
    cwd: root,
    onlyFiles: true,
  }))
    files[path] = sha(readFileSync(resolve(root, path)));
}
for (const path of [
  "package.json",
  "bun.lock",
  "wrangler.toml",
  ".profiling/pages-upload/functions.js",
  ".profiling/authenticated-entry.js",
  ".profiling/collector-upload-final/worker.js",
  ".profiling/build-control.json",
])
  files[path] = sha(readFileSync(resolve(root, path)));
let n = 1;
while (
  existsSync(resolve(out, `premeasurement-${String(n).padStart(3, "0")}.json`))
)
  n++;
const name = `premeasurement-${String(n).padStart(3, "0")}.json`;
const version = Bun.spawnSync([runtime, "--version"], {
  stdout: "pipe",
  stderr: "pipe",
});
if (version.exitCode) throw Error("Cannot identify native runtime");
const value = {
  createdAt: new Date().toISOString(),
  protocolSha256: files["scripts/profiling/PROTOCOL.json"],
  files,
  rootLocks: { "bun.lock": files["bun.lock"] },
  runtime: {
    version: version.stdout.toString().trim(),
    sha256: sha(readFileSync(runtime)),
  },
  measurementRunYet: false,
};
writeFileSync(resolve(out, name), JSON.stringify(value, null, 2) + "\n", {
  flag: "wx",
});
console.log(name);

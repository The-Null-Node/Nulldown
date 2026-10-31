import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Bun builds the driver; Node runs Miniflare and its restart subprocesses.
const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || (args[0] && !args[0].startsWith("--evidence="))) {
  throw new Error(
    "Usage: test:state-plane:native [--evidence=<fresh directory>]",
  );
}
const requested = args[0]?.slice("--evidence=".length);
if (args.length && !requested) throw new Error("Evidence directory is empty");
const evidence = requested
  ? resolve(requested)
  : mkdtempSync(join(tmpdir(), "nulldown-state-plane-"));
mkdirSync(evidence, { recursive: true });
if (readdirSync(evidence).length) {
  throw new Error("Evidence directory must be empty; use a fresh directory");
}
const output = await Bun.build({
  entrypoints: [join(root, "scripts/state-plane/native-contracts.ts")],
  outdir: evidence,
  naming: "native-contracts.mjs",
  target: "node",
});
if (!output.success)
  throw new AggregateError(output.logs, "Native driver build failed");
console.log(`State Plane native evidence: ${evidence}`);
const child = Bun.spawn(
  [
    "node",
    join(evidence, "native-contracts.mjs"),
    `--root=${root}`,
    `--evidence=${evidence}`,
  ],
  {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: join(evidence, "empty-home"),
      TMPDIR: join(evidence, "temp"),
      CI: "true",
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_WRITE_LOGS: "false",
    },
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exitCode = await child.exited;

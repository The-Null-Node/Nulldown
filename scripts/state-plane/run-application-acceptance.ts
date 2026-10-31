import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || (args[0] && !args[0].startsWith("--evidence="))) {
  throw Error(
    "Usage: test:state-plane:application [--evidence=<fresh directory>]",
  );
}
const requested = args[0]?.slice("--evidence=".length);
if (args.length && !requested) throw Error("Evidence directory is empty");
const evidence = requested
  ? resolve(requested)
  : mkdtempSync(join(tmpdir(), "nulldown-application-"));
mkdirSync(evidence, { recursive: true });
if (readdirSync(evidence).length)
  throw Error("Evidence directory must be empty");
for (const name of ["empty-home", "temp"]) mkdirSync(join(evidence, name));
const build = await Bun.build({
  entrypoints: [join(root, "scripts/state-plane/application-acceptance.ts")],
  outdir: evidence,
  naming: "application-acceptance.mjs",
  target: "node",
  metafile: true,
});
if (!build.success)
  throw new AggregateError(build.logs, "Application driver build failed");
// Build a dependency graph for the separately executed source CLI. Its output
// stays in memory; the acceptance still invokes the maintained CLI entrypoint.
const cliGraph = await Bun.build({
  entrypoints: [join(root, "bin/nulldown.ts")],
  target: "bun",
  metafile: true,
});
if (!cliGraph.success)
  throw new AggregateError(cliGraph.logs, "CLI graph build failed");
if (!build.metafile || !cliGraph.metafile)
  throw Error("Bun metafiles are required");
const hash = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const graphs = {
  driver: Object.keys(build.metafile.inputs).map((path) =>
    realpathSync(resolve(root, path)),
  ),
  cli: Object.keys(cliGraph.metafile.inputs).map((path) =>
    realpathSync(resolve(root, path)),
  ),
};
const paths = new Set([
  ...graphs.driver,
  ...graphs.cli,
  ...[
    "scripts/state-plane/run-application-acceptance.ts",
    "package.json",
    "bun.lock",
    "tsconfig.json",
  ].map((path) => realpathSync(join(root, path))),
  ...readdirSync(join(root, "migrations"))
    .filter((path) => path.endsWith(".sql"))
    .map((path) => realpathSync(join(root, "migrations", path))),
]);
for (const path of paths)
  if (!path.startsWith(realpathSync(root) + "/"))
    throw Error(`Mixed source tree: ${path}`);
writeFileSync(
  join(evidence, "application-source-pins.json"),
  JSON.stringify(
    {
      bunVersion: Bun.version,
      graphs,
      inputs: Object.fromEntries([...paths].map((path) => [path, hash(path)])),
      driverBundleHash: hash(join(evidence, "application-acceptance.mjs")),
    },
    null,
    2,
  ),
);
console.log(`State Plane application evidence: ${evidence}`);
const child = spawn(
  "node",
  [
    join(evidence, "application-acceptance.mjs"),
    `--root=${root}`,
    `--evidence=${evidence}`,
  ],
  {
    detached: true,
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: join(evidence, "empty-home"),
      TMPDIR: join(evidence, "temp"),
      CI: "true",
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_WRITE_LOGS: "false",
    },
    stdio: "inherit",
  },
);
writeFileSync(
  join(evidence, "application-launcher.json"),
  JSON.stringify(
    {
      pid: process.pid,
      driverPid: child.pid,
      deadlineMs: 210000,
      termGraceMs: 2000,
      hardStopMs: 5000,
    },
    null,
    2,
  ),
);
// Independent watchdog also works when the driver event loop or mf.dispose is
// hung. Peers each own a process group (including their workerd descendants).
const groups = () => {
  let peers: number[] = [];
  try {
    peers = JSON.parse(
      readFileSync(join(evidence, "application-live-groups.json"), "utf8"),
    ) as number[];
  } catch {
    /* Driver may not have started. */
  }
  return [
    ...new Set(
      [child.pid, ...peers].filter(
        (pid): pid is number => Number.isSafeInteger(pid) && (pid ?? 0) > 1,
      ),
    ),
  ];
};
const signalGroups = (signal: NodeJS.Signals) => {
  for (const pid of groups()) {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        console.error("Group cleanup failed", pid, signal);
    }
  }
};
let escalation: ReturnType<typeof setTimeout> | undefined;
let hardStop: ReturnType<typeof setTimeout> | undefined;
let stopping = false;
const stop = (code: number) => {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  writeFileSync(
    join(evidence, "application-launcher-watchdog.json"),
    JSON.stringify(
      {
        code,
        groups: groups(),
        mechanism: "independent launcher process-group shutdown",
      },
      null,
      2,
    ),
  );
  signalGroups("SIGTERM");
  escalation = setTimeout(() => signalGroups("SIGKILL"), 2000);
  hardStop = setTimeout(() => {
    signalGroups("SIGKILL");
    process.exit(code);
  }, 5000);
};
const deadline = setTimeout(() => stop(124), 210000);
process.once("SIGTERM", () => stop(143));
process.once("SIGINT", () => stop(130));
try {
  await new Promise<void>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!stopping) process.exitCode = code ?? 1;
      resolveExit();
    });
  });
} finally {
  clearTimeout(deadline);
  clearTimeout(escalation);
  clearTimeout(hardStop);
  signalGroups("SIGKILL");
}

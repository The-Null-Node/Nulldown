import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import type { BuildOptions, BuildResult } from "esbuild";

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
const hash = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const canonicalInputs = (inputs: Record<string, unknown>) =>
  Object.keys(inputs)
    .map((path) => realpathSync(resolve(root, path)))
    .sort();
// Discovery builds never write execution artifacts. Only their input sets survive.
const discoverBun = async (entry: string, target: "node" | "bun") => {
  const discovery = await Bun.build({
    entrypoints: [join(root, entry)],
    target,
    metafile: true,
  });
  if (!discovery.success)
    throw new AggregateError(discovery.logs, "Source discovery failed");
  if (!discovery.metafile) throw Error("Bun metafile is required");
  return canonicalInputs(discovery.metafile.inputs);
};
const esbuild = createRequire(join(root, "package.json"))("esbuild") as {
  build(options: BuildOptions): Promise<BuildResult>;
};
const workerEntries = {
  state: "packages/nulldown-state-plane/src/worker.ts",
  application:
    "packages/nulldown-state-plane/test/application-worker.fixture.ts",
};
const discoverWorker = async (entry: string) => {
  const discovery = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:workers"],
    metafile: true,
    write: false,
  });
  return canonicalInputs(discovery.metafile!.inputs);
};
const graphs = {
  driver: await discoverBun(
    "scripts/state-plane/application-acceptance.ts",
    "node",
  ),
  cli: await discoverBun("bin/nulldown.ts", "bun"),
  state: await discoverWorker(workerEntries.state),
  application: await discoverWorker(workerEntries.application),
};
const paths = new Set([
  ...Object.values(graphs).flat(),
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
const inputs = Object.fromEntries([...paths].map((path) => [path, hash(path)]));
const verifyPins = () => {
  for (const [path, digest] of Object.entries(inputs))
    assert.equal(
      hash(path),
      digest,
      `Source changed across execution compilation: ${path}`,
    );
};
// Pins exist before either final compilation; the driver repeats this protocol for Workers.
writeFileSync(
  join(evidence, "application-source-pins-before-build.json"),
  JSON.stringify(
    {
      bunVersion: Bun.version,
      graphs,
      inputs,
      protocol: "discover-discard-pin-compile-verify-v1",
    },
    null,
    2,
  ),
);
verifyPins();
const build = await Bun.build({
  entrypoints: [join(root, "scripts/state-plane/application-acceptance.ts")],
  outdir: evidence,
  naming: "application-acceptance.mjs",
  target: "node",
  metafile: true,
});
if (!build.success)
  throw new AggregateError(
    build.logs,
    "Pinned application driver build failed",
  );
assert.ok(build.metafile);
assert.deepEqual(
  canonicalInputs(build.metafile.inputs),
  graphs.driver,
  "Driver dependency set changed after pinning",
);
verifyPins();
// The CLI scenario executes the maintained source entrypoint. Validate its entire
// final compilation graph from the same pins; discard this validation bundle.
assert.deepEqual(
  await discoverBun("bin/nulldown.ts", "bun"),
  graphs.cli,
  "CLI dependency set changed after pinning",
);
verifyPins();
writeFileSync(
  join(evidence, "application-source-pins.json"),
  JSON.stringify(
    {
      bunVersion: Bun.version,
      graphs,
      inputs,
      protocol: "discover-discard-pin-compile-verify-v1",
      driverBundleHash: hash(join(evidence, "application-acceptance.mjs")),
    },
    null,
    2,
  ),
);
console.log(`State Plane application evidence: ${evidence}`);
const registrationProbe = process.env.NULLDOWN_ACCEPTANCE_REGISTRATION_PROBE;
assert.ok(
  registrationProbe === undefined ||
    ["failed", "timeout", "missing-leader", "malformed-leader"].includes(
      registrationProbe,
    ),
  "unknown registration probe",
);
const probeReady = join(evidence, "launcher-registration.ready");
const child = spawn(
  "node",
  registrationProbe
    ? [
        "-e",
        `
    const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
    c.once('spawn',()=>require('node:fs').writeFileSync(${JSON.stringify(probeReady)},String(c.pid)));
    setInterval(()=>{},1000);
  `,
      ]
    : [
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
    stdio: registrationProbe ? "pipe" : "inherit",
  },
);
// Own the handle and both terminal events before any process-table or file I/O.
const childExit = new Promise<number | null>((resolveExit, reject) => {
  child.once("error", reject);
  child.once("exit", resolveExit);
});
void childExit.catch(() => {});
// The independent watchdog retains identities, not just reusable numeric PGIDs.
interface Identity {
  pid: number;
  uid: number;
  started: string;
}
interface Group {
  pid: number;
  leader: Identity;
  members: Identity[];
}
const table = () => {
  const result = spawnSync(
    "ps",
    ["-axo", "pid=,ppid=,pgid=,uid=,lstart=,stat="],
    {
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  assert.equal(
    result.error,
    undefined,
    "launcher process-table inspection failed",
  );
  assert.equal(result.status, 0, "launcher process-table inspection failed");
  const rows = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const fields = line.trim().split(/\s+/);
      assert.equal(fields.length, 10, "unrecognized process-table row");
      const [pid, ppid, pgid, uid] = fields.slice(0, 4).map(Number);
      assert.ok([pid, ppid, pgid, uid].every(Number.isSafeInteger));
      return {
        pid,
        ppid,
        pgid,
        uid,
        started: fields.slice(4, 9).join(" "),
        state: fields[9],
      };
    });
  assert.ok(
    rows.some((row) => row.pid === process.pid),
    "launcher process-table visibility required",
  );
  return rows;
};
let driverProvisional = true;
const driverGroup: Group = {
  pid: child.pid!,
  leader: { pid: child.pid!, uid: -1, started: "unverified" },
  members: [],
};
const registerDriver = (rows: ReturnType<typeof table>) => {
  assert.ok(
    child.exitCode === null && child.signalCode === null,
    "owned driver already exited",
  );
  const leader = rows.find((row) => row.pid === child.pid);
  assert.ok(
    leader &&
      leader.pgid === child.pid &&
      leader.ppid === process.pid &&
      leader.uid === process.getuid!(),
    "driver detached leader identity required",
  );
  driverGroup.leader = leader;
  driverGroup.members = rows.filter((row) => row.pgid === child.pid);
  driverProvisional = false;
};
const knownGroups = new Map<number, Group>([[driverGroup.pid, driverGroup]]);
const retired = new Set<number>();
const cleanupRows: {
  pid: number;
  signal: string;
  outcome: string;
  error?: string;
}[] = [];
const groups = () => {
  try {
    const peers = JSON.parse(
      readFileSync(join(evidence, "application-group-identities.json"), "utf8"),
    ) as Group[];
    for (const group of peers) {
      assert.ok(
        Number.isSafeInteger(group.pid) &&
          group.pid > 1 &&
          group.leader.pid === group.pid &&
          Array.isArray(group.members),
      );
      if (!retired.has(group.pid)) knownGroups.set(group.pid, group);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return [...knownGroups.values()];
};
const same = (a: Identity, b: Identity) =>
  a.pid === b.pid && a.uid === b.uid && a.started === b.started;
const members = (group: Group) => {
  assert.ok(
    group.leader.uid >= 0 && group.leader.started !== "unverified",
    "unknown group identity remains registered; refusing signal",
  );
  const rows = table().filter((row) => row.pgid === group.pid);
  const currentLeader = rows.find((row) => row.pid === group.pid);
  if (currentLeader)
    assert.ok(
      same(currentLeader, group.leader),
      "launcher group identity changed; refusing signal",
    );
  for (const row of rows) {
    assert.equal(
      row.uid,
      group.leader.uid,
      "launcher group uid changed; refusing signal",
    );
    if (!currentLeader)
      assert.ok(
        group.members.some((known) => same(known, row)),
        "launcher unregistered group member; refusing signal",
      );
  }
  group.members = rows;
  return rows;
};
const verifyGone = async (group: Group) => {
  const deadline = performance.now() + 2000;
  do {
    if (members(group).length === 0) {
      knownGroups.delete(group.pid);
      retired.add(group.pid);
      return;
    }
    await new Promise<void>((done) => setTimeout(done, 25));
  } while (performance.now() < deadline);
  throw Error(`Launcher group ${group.pid} still present (including zombies)`);
};
const retainCleanup = () =>
  writeFileSync(
    join(evidence, "application-launcher-cleanup.json"),
    JSON.stringify(
      {
        groupsStillRegistered: [...knownGroups.keys()],
        checks: cleanupRows,
        driverProvisional,
        registrationProbe,
        ownedPipesClosed:
          (!child.stdin || child.stdin.destroyed) &&
          (!child.stdout || child.stdout.destroyed) &&
          (!child.stderr || child.stderr.destroyed),
        passed:
          knownGroups.size === 0 &&
          cleanupRows.every((row) => row.error === undefined),
      },
      null,
      2,
    ),
  );
const signalGroups = async (signal: NodeJS.Signals) => {
  await Promise.all(
    groups().map(async (group) => {
      try {
        if (members(group).length > 0) {
          try {
            process.kill(-group.pid, signal);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "EPERM" && code !== "ESRCH") throw error;
            try {
              await verifyGone(group);
            } catch {
              throw Error(
                `Launcher group ${group.pid} ${signal} failed: ${code}; absence not verified`,
              );
            }
            cleanupRows.push({
              pid: group.pid,
              signal,
              outcome: `verified-empty-after-${code}`,
            });
            return;
          }
        }
        if (signal === "SIGKILL" || members(group).length === 0)
          await verifyGone(group);
        cleanupRows.push({
          pid: group.pid,
          signal,
          outcome: knownGroups.has(group.pid) ? "signalled" : "verified-empty",
        });
      } catch (error) {
        process.exitCode = 1;
        cleanupRows.push({
          pid: group.pid,
          signal,
          outcome: "not-verified-empty",
          error: String(error).slice(0, 300),
        });
      }
    }),
  );
  retainCleanup();
};
const cleanupFailure = (error: unknown) => {
  process.exitCode = 1;
  cleanupRows.push({
    pid: child.pid!,
    signal: "inspection",
    outcome: "not-verified-empty",
    error: String(error).slice(0, 300),
  });
  try {
    retainCleanup();
  } catch {
    console.error("Launcher could not retain cleanup evidence");
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
        groups: [...knownGroups.keys()],
        mechanism: "independent launcher process-group shutdown",
      },
      null,
      2,
    ),
  );
  void signalGroups("SIGTERM").catch(cleanupFailure);
  escalation = setTimeout(() => {
    void signalGroups("SIGKILL").catch(cleanupFailure);
  }, 2000);
  hardStop = setTimeout(() => {
    try {
      retainCleanup();
    } catch {
      /* Exit still fails closed. */
    }
    process.exit(code);
  }, 5000);
};
const deadline = setTimeout(() => stop(124), 210000);
process.once("SIGTERM", () => stop(143));
process.once("SIGINT", () => stop(130));
const registrationDeadline = setTimeout(() => stop(1), 5000);
try {
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
  retainCleanup();
  if (registrationProbe) {
    const barrier = spawnSync(
      process.execPath,
      [
        "-e",
        `const fs=require('node:fs');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(probeReady)})){clearInterval(t)}},5)`,
      ],
      { timeout: 1000 },
    );
    assert.equal(barrier.status, 0, "launcher real descendant ready");
    if (registrationProbe === "failed" || registrationProbe === "timeout") {
      const failed =
        registrationProbe === "failed"
          ? spawnSync(join(evidence, "nonexistent-ps"), [])
          : spawnSync(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
              timeout: 20,
            });
      assert.equal(
        failed.error,
        undefined,
        "injected launcher inspection failure",
      );
    }
  }
  const rows = table();
  registerDriver(
    registrationProbe === "missing-leader"
      ? rows.filter((row) => row.pid !== child.pid)
      : registrationProbe === "malformed-leader"
        ? rows.map((row) =>
            row.pid === child.pid ? { ...row, pgid: -1 } : row,
          )
        : rows,
  );
  clearTimeout(registrationDeadline);
  const code = await childExit;
  if (!stopping) process.exitCode = code ?? 1;
} catch (error) {
  cleanupFailure(error);
} finally {
  try {
    if (driverProvisional) {
      try {
        registerDriver(table());
      } catch (error) {
        cleanupFailure(error);
      }
      if (driverProvisional) {
        // Only the still-owned direct handle may be killed without group identity.
        try {
          if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL");
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              childExit,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(Error("unregistered driver exit deadline")),
                  2000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
          assert.equal(
            table().filter((row) => row.pgid === child.pid).length,
            0,
            "unknown driver descendants remain registered",
          );
          knownGroups.delete(child.pid!);
          retired.add(child.pid!);
        } catch (error) {
          cleanupFailure(error);
        }
      }
    }
    await signalGroups("SIGKILL").catch(cleanupFailure);
  } finally {
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    try {
      retainCleanup();
    } catch (error) {
      cleanupFailure(error);
    }
    clearTimeout(registrationDeadline);
    clearTimeout(deadline);
    clearTimeout(escalation);
    clearTimeout(hardStop);
  }
}

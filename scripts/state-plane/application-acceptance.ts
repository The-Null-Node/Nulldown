import assert from "node:assert/strict";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  appendFileSync,
  readdirSync,
  readFileSync,
  lstatSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type * as MiniflareModule from "miniflare";
import type { BuildOptions, BuildResult } from "esbuild";
import {
  createNulldownClient,
  type NulldownClient,
  type NulldownCreateDropRequest,
} from "../../src/client/nulldown-client";
import { sealDropForAuthoring } from "../../shared/drop/authoring-crypto";
import { decodeDropEnvelope } from "../../shared/drop/codecs/envelope-v1";
import type { DropVisibility } from "../../shared/drop/types";
import {
  nullplugUiRuntimeFactId,
  nullplugUiStatePatchFactKey,
  nullplugUiStateSnapshotKey,
  nullplugUiResponseFactKey,
  type NullplugUiRuntimeFact,
  type NullplugUiResponseFact,
  type NullplugUiStatePatchFact,
  type NullplugUiStateSnapshot,
} from "../../shared/nullplug/ui";
import type {
  BranchAuthorityRecord,
  BranchInitializationReceipt,
} from "../../shared/drop/branch-lifecycle";
import type {
  BranchRuntimeFactReceipt,
  BranchRuntimeFactOutbox,
} from "../../shared/drop/branch-runtime-facts";
import { issueAccountSessionToken } from "../../functions/api/_lib/accounts/session/token";
import { canonicalizeAccountEncryptionRecipient } from "../../functions/api/_lib/accounts/identity/records";
import {
  branchStateShardName,
  decodeBranchStateRpcResult,
  type BranchStateRpcResult,
} from "../../packages/nulldown-state-plane/src/shard-router";
import {
  isDropBranchRuntimeFact,
  type DropBranchRuntimeFact,
  type DropDiffAppendResponse,
  type DropDiffEvent,
  type DropDiffPollResponse,
} from "../../shared/drop/diff";
import {
  isDropBranchContentResponse,
  isDropSnapshotListResponse,
  type DropBranchContentResponse,
  type DropBranchResolveResponse,
  type DropSnapshotListResponse,
} from "../../shared/drop/branch";
import {
  applicationFixture as fixture,
  applicationEdits as edits,
  applicationEvent,
  applicationSeed,
  applicationLifecycleFixture as lifecycle,
  applicationLifecycleRoots,
  applicationRuntimeFixture as runtimeFacts,
  applicationRuntimeRoots,
  applicationUnseededRoots,
  inspectApplicationRootStorage,
  type ApplicationRequestEvidence,
} from "../../packages/nulldown-state-plane/test/application-scenarios.fixture";

const argument = (key: string) =>
  process.argv
    .find((arg) => arg.startsWith(`--${key}=`))
    ?.slice(key.length + 3);
const root = resolve(argument("root") ?? process.cwd());
const evidenceArgument = argument("evidence");
if (!evidenceArgument)
  throw Error("Explicit --evidence= owned output directory required");
const evidence = resolve(evidenceArgument);
const require = createRequire(resolve(root, "package.json"));
const runtimeRequire = createRequire(
  resolve(root, "node_modules/wrangler/package.json"),
);
const compatibilityDate = "2026-08-26";
const requestDeadlineMs = 30000;
const shutdownDeadlineMs = 2000;
const harnessDeadlineMs = 180000;
const sensitiveValues = new Set<string>();
const registerPrivateJwk = (jwk: JsonWebKey) => {
  sensitiveValues.add(JSON.stringify(jwk));
  for (const key of ["d", "p", "q", "dp", "dq", "qi", "k"] as const) {
    const value = jwk[key];
    if (value) sensitiveValues.add(value);
  }
};
const redact = (text: string) => {
  for (const secret of sensitiveValues)
    text = text.replaceAll(secret, "[redacted]");
  return text.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]");
};
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

/** Bounded retained-artifact scan; native SQLite/R2 persistence is outside the plaintext log/config claim. */
function scanRetainedArtifactSecrets() {
  const limits = {
    directories: 128,
    depth: 16,
    files: 512,
    fileBytes: 16 * 1024 * 1024,
    totalBytes: 64 * 1024 * 1024,
  };
  const footprints = [
    ...new Set(
      [...sensitiveValues].flatMap((value) => [
        value,
        JSON.stringify(value).slice(1, -1),
      ]),
    ),
  ].map((value) => Buffer.from(value));
  const files: { path: string; bytes: number }[] = [];
  const leakedPaths: string[] = [];
  let totalBytes = 0;
  let directories = 0;
  const visit = (directory: string, prefix = "", depth = 0) => {
    assert.ok(
      ++directories <= limits.directories && depth <= limits.depth,
      "artifact traversal budget exceeded",
    );
    for (const entry of readdirSync(directory)) {
      if (!prefix && entry === "native-state") continue;
      const path = resolve(directory, entry);
      const name = prefix + entry;
      const stat = lstatSync(path);
      assert.equal(
        stat.isSymbolicLink(),
        false,
        "artifact scan does not follow symlinks",
      );
      if (stat.isDirectory()) {
        visit(path, `${name}/`, depth + 1);
        continue;
      }
      assert.ok(
        stat.isFile(),
        "artifact scan accepts only regular retained files",
      );
      totalBytes += stat.size;
      assert.ok(
        files.length < limits.files &&
          stat.size <= limits.fileBytes &&
          totalBytes <= limits.totalBytes,
        "retained-artifact scan budget exceeded",
      );
      const bytes = readFileSync(path);
      if (footprints.some((footprint) => bytes.includes(footprint)))
        leakedPaths.push(name);
      files.push({ path: name, bytes: bytes.byteLength });
    }
  };
  visit(evidence);
  return {
    passed: leakedPaths.length === 0,
    scope:
      "retained artifacts including plaintext logs/configuration; native-state persistence excluded",
    limits,
    files,
    totalBytes,
    footprints: footprints.length,
    leakedPaths,
  };
}
const diffPath = (
  branch: string = fixture.branch,
  rootId: string = fixture.root,
) => `/api/diff/${rootId}?branchId=${encodeURIComponent(branch)}`;

interface Command {
  action: string;
  secret?: string;
  token?: string;
  clientId?: string;
  baseUrl?: string;
  branch?: string;
  rootId?: string;
  content?: string;
  event?: DropDiffEvent;
  events?: DropDiffEvent[];
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  json?: Record<string, unknown>;
  cursor?: string;
  limit?: number;
  factCursor?: string | null;
  factLimit?: number;
  stateFact?: NullplugUiStatePatchFact | NullplugUiStateSnapshot;
  responseFact?: NullplugUiResponseFact;
  excludeClient?: string;
  loseAck?: boolean;
  snapshotId?: number;
  create?: NulldownCreateDropRequest;
  visibility?: DropVisibility;
  authoring?: AuthoringKeys;
  providerPrivateJwk?: JsonWebKey;
  account?: {
    accountId: string;
    signingPublicJwk: JsonWebKey;
    encryptionPublicJwk: JsonWebKey;
  };
  fault?: {
    method:
      | "reserve"
      | "initialize"
      | "readPlacement"
      | "readHead"
      | "appendRuntimeFact"
      | "readRuntimeFactHead";
    stage: "before" | "after";
    mode: "fail" | "hold" | "pause" | "stale-generation";
  };
}
interface AuthoringKeys {
  accountId: string;
  signingPublicJwk: JsonWebKey;
  signingPrivateJwk: JsonWebKey;
  encryptionPublicJwk: JsonWebKey;
  providerPublicJwk: JsonWebKey;
}
interface RootInspection {
  exists: boolean;
  sealed: boolean;
  containsPlaintext: boolean;
  unexpectedFields: string[];
  accountId?: string;
  visibility?: DropVisibility;
  revision?: string;
  projection: {
    account_id: string;
    visibility: string;
    deleted_at: number | null;
  } | null;
  legacyBranches: number;
}
interface Failure {
  ok: false;
  error: { code?: string; status?: number; message?: string };
}
type Result<T> = { ok: true; value: T } | Failure;
interface Inspection {
  counts: Record<string, number>;
  events: { event_id: string; event_seq: number; snapshot_id: number }[];
  receipts: unknown[];
  outbox: unknown[];
  authority?: BranchAuthorityRecord | null;
  initializationReceipt?: BranchInitializationReceipt | null;
}

interface FactSubmission {
  stored: boolean;
  duplicate: boolean;
  indexed: boolean;
  key: string;
  fact: NullplugUiRuntimeFact;
  runtimeFact: { event: DropBranchRuntimeFact; appended: boolean };
}

interface RuntimeFactInspection {
  counts: Record<string, number>;
  headSeq: number;
  facts: DropBranchRuntimeFact[];
  receipts: BranchRuntimeFactReceipt[];
  outbox: BranchRuntimeFactOutbox[];
}

function value<T>(result: Result<T>): T {
  assert.equal(
    result.ok,
    true,
    result.ok ? undefined : JSON.stringify(result.error),
  );
  return (result as { ok: true; value: T }).value;
}

function networkGuard() {
  const net = require("node:net") as {
    Socket: { prototype: { connect: (...args: unknown[]) => unknown } };
    _normalizeArgs: (args: unknown[]) => [{ path?: string; host?: string }];
  };
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args: unknown[]) {
    const options = net._normalizeArgs(args)[0];
    if (
      !options.path &&
      !["localhost", "127.0.0.1", "::1", "[::1]"].includes(
        options.host ?? "localhost",
      )
    )
      throw Error("HOST_NETWORK_DISABLED");
    return original.apply(this, args);
  };
}

async function bounded<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface ManagedChild {
  child: ChildProcessWithoutNullStreams;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stopping?: Promise<void>;
  reaping?: Promise<void>;
  group: ProcessGroup;
  provisional?: boolean;
  sendSignal?: GroupSignal;
}
interface ProcessIdentity {
  pid: number;
  uid: number;
  started: string;
}
interface ProcessGroup {
  pid: number;
  leader: ProcessIdentity;
  members: ProcessIdentity[];
}
type GroupSignal = (
  pid: number,
  signal: NodeJS.Signals,
) => void | Promise<void>;
const cleanupSignalEvidence: {
  pid: number;
  signal: string;
  code: string;
  outcome: string;
}[] = [];
const exitCleanupErrors: string[] = [];

/** Reads identities only, never command lines or environments; failed/partial ps is not proof of absence. */
function processTable() {
  const result = spawnSync(
    "ps",
    ["-axo", "pid=,ppid=,pgid=,uid=,lstart=,stat="],
    {
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  assert.equal(result.error, undefined, "process-table inspection failed");
  assert.equal(result.status, 0, "process-table inspection failed");
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
    "process-table visibility required",
  );
  return rows;
}
const sameProcess = (a: ProcessIdentity, b: ProcessIdentity) =>
  a.pid === b.pid && a.uid === b.uid && a.started === b.started;
function registerGroup(pid: number, inspect = processTable): ProcessGroup {
  const rows = inspect();
  const leader = rows.find((row) => row.pid === pid);
  assert.ok(
    leader &&
      leader.pgid === pid &&
      leader.ppid === process.pid &&
      leader.uid === process.getuid!(),
    "spawned detached leader identity required",
  );
  return { pid, leader, members: rows.filter((row) => row.pgid === pid) };
}
function groupMembers(group: ProcessGroup) {
  const members = processTable().filter((row) => row.pgid === group.pid);
  const leader = members.find((row) => row.pid === group.pid);
  if (leader)
    assert.ok(
      sameProcess(leader, group.leader),
      "process-group leader identity changed; refusing signal",
    );
  for (const member of members) {
    assert.equal(
      member.uid,
      group.leader.uid,
      "process-group uid changed; refusing signal",
    );
    if (!leader)
      assert.ok(
        group.members.some((known) => sameProcess(known, member)),
        "unregistered remaining group member; refusing signal",
      );
  }
  group.members = members;
  return members;
}
async function waitGroupGone(group: ProcessGroup) {
  const deadline = performance.now() + shutdownDeadlineMs;
  do {
    if (groupMembers(group).length === 0) return;
    await new Promise<void>((done) => setTimeout(done, 25));
  } while (performance.now() < deadline);
  throw Error(`Process group ${group.pid} still present (including zombies)`);
}
/** EPERM/ESRCH become success only after an identity-checked, empty process-table observation. */
async function signalGroup(
  group: ProcessGroup,
  signal: NodeJS.Signals,
  send: GroupSignal = (pid, value) => {
    process.kill(-pid, value);
  },
) {
  if (groupMembers(group).length === 0) return;
  persistGroups();
  try {
    await send(group.pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    if (code === "EPERM" || code === "ESRCH") {
      try {
        await waitGroupGone(group);
        cleanupSignalEvidence.push({
          pid: group.pid,
          signal,
          code,
          outcome: "verified-empty-after-error",
        });
        return;
      } catch {
        /* Keep the original permission error and the registered group. */
      }
    }
    cleanupSignalEvidence.push({
      pid: group.pid,
      signal,
      code,
      outcome: "not-verified-empty",
    });
    throw Error(
      `Process group ${group.pid} ${signal} failed: ${code}; absence not verified`,
      { cause: error },
    );
  }
}
const managedChildren = new Map<number, ManagedChild>();
const shutdownEvidence: {
  pid: number;
  reason: string;
  signals: string[];
  exited: boolean;
  pipesDestroyed: boolean;
}[] = [];
const processWideOutbound: { pid: number; attempts: number }[] = [];
function persistGroups() {
  const path = resolve(evidence, "application-live-groups.json");
  writeFileSync(path + ".next", JSON.stringify([...managedChildren.keys()]));
  renameSync(path + ".next", path);
  const identities = resolve(evidence, "application-group-identities.json");
  writeFileSync(
    identities + ".next",
    JSON.stringify([...managedChildren.values()].map((entry) => entry.group)),
  );
  renameSync(identities + ".next", identities);
}
async function reapGroup(managed: ManagedChild) {
  assert.equal(
    managed.provisional,
    false,
    "unverified group cannot be signalled",
  );
  await signalGroup(managed.group, "SIGKILL", managed.sendSignal);
  await waitGroupGone(managed.group);
  managedChildren.delete(managed.group.pid);
  persistGroups();
}
/** Recovers registration while the owned leader is still alive; otherwise retains unknown descendants. */
async function cleanupProvisional(managed: ManagedChild) {
  const { child } = managed;
  try {
    try {
      assert.ok(
        child.exitCode === null && child.signalCode === null,
        "owned leader already exited",
      );
      managed.group = registerGroup(child.pid!);
      managed.provisional = false;
      persistGroups();
      await reapGroup(managed);
    } catch (error) {
      if (!managed.provisional) throw error;
      // ChildProcess owns this unreaped direct child. Never signal an unknown PGID.
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await bounded(
        managed.exited,
        shutdownDeadlineMs,
        "unregistered child exit deadline",
      );
      const remaining = processTable().filter((row) => row.pgid === child.pid);
      assert.equal(
        remaining.length,
        0,
        "unknown descendant cleanup remains registered",
      );
      managedChildren.delete(child.pid!);
      persistGroups();
    }
  } finally {
    try {
      if (
        managed.provisional &&
        child.exitCode === null &&
        child.signalCode === null
      )
        child.kill("SIGKILL");
    } finally {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
}
function trackChild(
  child: ChildProcessWithoutNullStreams,
  inspect = processTable,
): ManagedChild {
  assert.ok(child.pid, "child process started");
  const pid = child.pid;
  const group: ProcessGroup = {
    pid,
    leader: { pid, uid: -1, started: "unverified" },
    members: [],
  };
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveExit) => {
    child.once("exit", (code, signal) => {
      resolveExit({ code, signal });
      // Never throw out of EventEmitter callbacks. Exit is not group disappearance.
      if (!managed.stopping) {
        managed.reaping = managed.provisional
          ? cleanupProvisional(managed)
          : reapGroup(managed);
        void managed.reaping.catch((error: unknown) => {
          exitCleanupErrors.push(redact(String(error)));
        });
      }
    });
    child.once("error", () => resolveExit({ code: 1, signal: null }));
  });
  const managed: ManagedChild = { child, exited, group, provisional: true };
  managedChildren.set(pid, managed);
  const recover = () => {
    managed.stopping ??= cleanupProvisional(managed);
    void managed.stopping.catch((error: unknown) => {
      exitCleanupErrors.push(redact(String(error)));
    });
  };
  const deadline = setTimeout(recover, shutdownDeadlineMs);
  try {
    persistGroups();
    managed.group = registerGroup(pid, inspect);
    managed.provisional = false;
    persistGroups();
  } catch (error) {
    recover();
    throw error;
  } finally {
    clearTimeout(deadline);
  }
  return managed;
}
function terminate(managed: ManagedChild, reason: string): Promise<void> {
  if (managed.stopping) return managed.stopping;
  managed.stopping = (async () => {
    const { child } = managed;
    const row = {
      pid: child.pid!,
      reason,
      signals: [] as string[],
      exited: false,
      pipesDestroyed: false,
    };
    shutdownEvidence.push(row);
    try {
      row.signals.push("SIGTERM");
      await signalGroup(managed.group, "SIGTERM", managed.sendSignal);
      try {
        await bounded(
          managed.exited,
          shutdownDeadlineMs,
          "SIGTERM grace exceeded",
        );
      } catch {
        row.signals.push("SIGKILL");
        await signalGroup(managed.group, "SIGKILL", managed.sendSignal);
        await bounded(
          managed.exited,
          shutdownDeadlineMs,
          "SIGKILL exit deadline exceeded",
        );
      }
      row.exited = true;
    } finally {
      try {
        await reapGroup(managed);
      } finally {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        row.pipesDestroyed = true;
      }
    }
  })();
  return managed.stopping;
}
async function terminateAll(reason: string) {
  return Promise.allSettled(
    [...managedChildren.values()].map((child) => terminate(child, reason)),
  );
}

/** Real subprocess fault probes distinguish a disappearing group from denied live-group cleanup. */
async function cleanupFaultProbes() {
  const registrationProbes: {
    kind: string;
    pid: number;
    descendants: number;
    pipesClosed: boolean;
    ms: number;
  }[] = [];
  for (const kind of [
    "failed",
    "timeout",
    "missing-leader",
    "malformed-leader",
  ] as const) {
    const ready = resolve(evidence, `registration-${kind}.ready`);
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
      c.once('spawn',()=>require('node:fs').writeFileSync(${JSON.stringify(ready)},String(c.pid)));
      setInterval(()=>{},1000);
    `,
      ],
      { detached: true, stdio: "pipe" },
    );
    const started = performance.now();
    assert.throws(() =>
      trackChild(child, () => {
        assert.ok(
          managedChildren.has(child.pid!),
          "provisional registry precedes inspection",
        );
        assert.ok(
          child.listenerCount("exit") && child.listenerCount("error"),
          "handlers precede inspection",
        );
        const barrier = spawnSync(
          process.execPath,
          [
            "-e",
            `const fs=require('node:fs');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(t)}},5)`,
          ],
          { timeout: 1000 },
        );
        assert.equal(
          barrier.status,
          0,
          "real descendant started before inspection fault",
        );
        if (kind === "failed" || kind === "timeout") {
          const failed =
            kind === "failed"
              ? spawnSync(resolve(evidence, "nonexistent-ps"), [])
              : spawnSync(
                  process.execPath,
                  ["-e", "setInterval(()=>{},1000)"],
                  { timeout: 20 },
                );
          assert.equal(
            failed.error,
            undefined,
            "injected process-table inspection failure",
          );
        }
        const rows = processTable();
        return kind === "missing-leader"
          ? rows.filter((row) => row.pid !== child.pid)
          : rows.map((row) =>
              row.pid === child.pid ? { ...row, pgid: -1 } : row,
            );
      }),
    );
    const managed = managedChildren.get(child.pid!)!;
    assert.ok(managed?.stopping, "registration failure owns bounded recovery");
    const descendants = managed.group.members.length - 1;
    await managed.stopping;
    assert.ok(
      descendants >= 1,
      "recovery captured the real descendant before signalling",
    );
    assert.equal(
      processTable().some((row) => row.pgid === child.pid),
      false,
    );
    assert.equal(managedChildren.has(child.pid!), false);
    const pipesClosed =
      child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed;
    assert.ok(pipesClosed);
    assert.ok(
      performance.now() - started < shutdownDeadlineMs * 3,
      "registration recovery bounded",
    );
    registrationProbes.push({
      kind,
      pid: child.pid!,
      descendants,
      pipesClosed,
      ms: performance.now() - started,
    });
  }
  const create = () =>
    trackChild(
      spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        detached: true,
        stdio: "pipe",
      }),
    );
  const vanished = create();
  // This probe owns reaping rather than the exit callback.
  vanished.stopping = Promise.resolve();
  await signalGroup(vanished.group, "SIGKILL", async (pid, signal) => {
    process.kill(-pid, signal);
    await vanished.exited;
    throw Object.assign(Error("synthetic post-exit denial"), { code: "EPERM" });
  });
  await reapGroup(vanished);
  vanished.child.stdin.destroy();
  vanished.child.stdout.destroy();
  vanished.child.stderr.destroy();
  assert.equal(managedChildren.has(vanished.group.pid), false);
  const callback = trackChild(
    spawn(
      process.execPath,
      [
        "-e",
        `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
    child.once('spawn',()=>process.stdout.write('ready\\n'));
    process.stdin.once('data',()=>process.exit(0));
  `,
      ],
      { detached: true, stdio: "pipe" },
    ),
  );
  const callbackErrorOffset = exitCleanupErrors.length;
  try {
    await bounded(
      once(callback.child.stdout, "data"),
      shutdownDeadlineMs,
      "cleanup callback probe startup",
    );
    assert.equal(groupMembers(callback.group).length, 2);
    callback.sendSignal = (pid, signal) => {
      process.kill(-pid, signal);
      throw Object.assign(Error("synthetic exit-callback denial"), {
        code: "EPERM",
      });
    };
    callback.child.stdin.write("exit\n");
    await bounded(
      callback.exited,
      shutdownDeadlineMs,
      "cleanup callback probe leader exit",
    );
    await callback.reaping;
    assert.equal(
      exitCleanupErrors.length,
      callbackErrorOffset,
      "exit callback verified vanished group without uncaught error",
    );
    assert.equal(managedChildren.has(callback.group.pid), false);
  } finally {
    callback.sendSignal = undefined;
    if (managedChildren.has(callback.group.pid))
      await terminate(callback, "callback probe recovery");
    callback.child.stdin.destroy();
    callback.child.stdout.destroy();
    callback.child.stderr.destroy();
  }
  const live = create();
  live.sendSignal = () => {
    throw Object.assign(Error("synthetic live denial"), { code: "EPERM" });
  };
  const started = performance.now();
  try {
    await assert.rejects(
      terminate(live, "EPERM live-group fault probe"),
      /EPERM.*absence not verified/,
    );
    assert.ok(
      performance.now() - started < shutdownDeadlineMs * 3,
      "permission failure bounded",
    );
    assert.equal(
      managedChildren.has(live.group.pid),
      true,
      "live denied group stays registered",
    );
    assert.ok(
      groupMembers(live.group).length > 0,
      "live denied group not claimed dead",
    );
    assert.ok(
      live.child.stdin.destroyed &&
        live.child.stdout.destroyed &&
        live.child.stderr.destroyed,
      "pipes destroyed despite failed final signal",
    );
    let sent = false;
    const wrongIdentity = {
      ...live.group,
      leader: { ...live.group.leader, started: "reused-pid" },
    };
    await assert.rejects(
      signalGroup(wrongIdentity, "SIGKILL", () => {
        sent = true;
      }),
      /identity changed/,
    );
    assert.equal(sent, false, "unrelated/reused group must not be signalled");
  } finally {
    live.sendSignal = undefined;
    live.stopping = undefined;
    await terminate(live, "EPERM fault probe recovery");
  }
  assert.equal(managedChildren.has(live.group.pid), false);
  writeFileSync(
    resolve(evidence, "application-cleanup-probes.json"),
    JSON.stringify(
      {
        passed: true,
        registrationProbes,
        postExitEpermVerifiedEmpty: true,
        liveEpermRejectedAndRetained: true,
        failedSignalPipesDestroyed: true,
        reusedIdentityNotSignalled: true,
        exitCallbackEpermVerifiedEmpty: true,
        recoveredGroups: [
          vanished.group.pid,
          callback.group.pid,
          live.group.pid,
        ],
        evidence: cleanupSignalEvidence,
      },
      null,
      2,
    ),
  );
}

/** Archive complete bounded lines only, so secrets split across chunks are still redacted. */
function archiveStderr(child: ChildProcessWithoutNullStreams, name: string) {
  let pending = "",
    dropping = false,
    written = 0;
  const emit = (line: string) => {
    if (written >= 1000000) return;
    const safe = redact(line);
    written += Buffer.byteLength(safe);
    appendFileSync(resolve(evidence, `${name}-stderr.log`), safe);
  };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    pending += chunk;
    let newline: number;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline + 1);
      emit(
        dropping || line.length > 65536
          ? "[oversized stderr line omitted]\n"
          : line,
      );
      pending = pending.slice(newline + 1);
      dropping = false;
    }
    if (pending.length > 65536) {
      pending = "";
      dropping = true;
    }
  });
  child.stderr.once("close", () => {
    if (pending) emit(dropping ? "[oversized stderr line omitted]\n" : pending);
  });
}

/** Node subprocess transport; configuration containing synthetic secrets never enters reports. */
class Peer {
  readonly process: ChildProcessWithoutNullStreams;
  readonly ready: Promise<number>;
  private readonly managed: ManagedChild;
  private failed?: Error;
  private serial = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (result: Result<unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    mode: "runtime" | "client",
    probe?: "startup" | "request" | "close" | "exit",
  ) {
    const probeScript = `
      const {spawn}=require('node:child_process');
      process.on('SIGTERM',()=>{});
      spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});
      setInterval(()=>{},1000);
      if (${JSON.stringify(probe)} !== 'startup') {
        process.stdout.write(JSON.stringify({ready:true,pid:process.pid})+'\\n');
        require('node:readline').createInterface({input:process.stdin}).on('line',(line)=>{
          const {id,command}=JSON.parse(line);
          if(command.secret){
            const half=Math.floor(command.secret.length/2);
            process.stderr.write(command.secret.slice(0,half));
            setImmediate(()=>process.stderr.write(command.secret.slice(half)+'\\n'));
          }
          if (${JSON.stringify(probe)} === 'exit') process.stdout.write(JSON.stringify({id,result:{ok:true,value:{}}})+'\\n');
        });
      }
    `;
    this.process = spawn(
      process.execPath,
      probe
        ? ["-e", probeScript]
        : [
            process.argv[1],
            `--root=${root}`,
            `--evidence=${evidence}`,
            `--mode=${mode}`,
          ],
      {
        detached: true,
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: resolve(evidence, "empty-home"),
          TMPDIR: resolve(evidence, "temp"),
          CI: "true",
          WRANGLER_SEND_METRICS: "false",
          WRANGLER_WRITE_LOGS: "false",
        },
        stdio: "pipe",
      },
    );
    this.managed = trackChild(this.process);
    this.process.stdin.on("error", (error) => this.abort(error));
    archiveStderr(this.process, probe ? `watchdog-${probe}` : mode);
    let yes!: (pid: number) => void, no!: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => {
      yes = resolve;
      no = reject;
    });
    void this.ready.catch(() => {});
    const startup = setTimeout(
      () => {
        const error = Error(`${mode} startup deadline`);
        no(error);
        this.abort(error);
      },
      probe ? 500 : requestDeadlineMs,
    );
    createInterface({ input: this.process.stdout }).on("line", (line) => {
      let message: {
        ready?: boolean;
        pid: number;
        id: number;
        result: Result<unknown>;
      };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        this.abort(Error("Invalid subprocess protocol"));
        return;
      }
      if (message.ready) {
        clearTimeout(startup);
        yes(message.pid);
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      entry.resolve(message.result);
    });
    this.process.on("error", (error) => {
      no(error);
      this.abort(error);
    });
    this.process.on("exit", (code) => {
      clearTimeout(startup);
      const error = Error(`${mode} exited ${code}`);
      this.failed ??= error;
      no(error);
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      this.pending.clear();
    });
  }
  private abort(error: Error) {
    this.failed ??= error;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    void this.forceStop(error.message).catch(() => {
      process.exitCode = 1;
    });
  }
  forceStop(reason: string) {
    return terminate(this.managed, reason);
  }
  async call<T = unknown>(
    command: Command,
    deadlineMs = requestDeadlineMs,
  ): Promise<Result<T>> {
    if (this.failed) throw this.failed;
    await this.ready;
    if (this.failed) throw this.failed;
    const id = ++this.serial;
    const answer = new Promise<Result<unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.abort(Error(`Subprocess deadline: ${command.action}`));
      }, deadlineMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.process.stdin.write(JSON.stringify({ id, command }) + "\n");
    return (await answer) as Result<T>;
  }
  async close() {
    if (this.managed.stopping) {
      await this.managed.stopping;
      return;
    }
    if (this.process.exitCode !== null || this.process.signalCode !== null) {
      await this.managed.reaping;
      return;
    }
    try {
      const result = value(
        await this.call<{ outbound?: number }>(
          { action: "close" },
          shutdownDeadlineMs,
        ),
      );
      if (result.outbound !== undefined) {
        processWideOutbound.push({
          pid: this.process.pid!,
          attempts: result.outbound,
        });
        assert.equal(result.outbound, 0);
      }
      this.process.stdin.end();
      await bounded(
        this.managed.exited,
        shutdownDeadlineMs,
        "Subprocess close exit deadline",
      );
      await this.managed.reaping;
    } catch (error) {
      await this.forceStop("close failed or timed out");
      throw error;
    } finally {
      this.process.stdin.destroy();
      this.process.stdout.destroy();
      this.process.stderr.destroy();
    }
  }
}

async function serveCommands(handle: (command: Command) => Promise<unknown>) {
  process.stdout.write(
    JSON.stringify({ ready: true, pid: process.pid }) + "\n",
  );
  const pending = new Set<Promise<void>>();
  for await (const line of createInterface({ input: process.stdin })) {
    const { id, command } = JSON.parse(line) as {
      id: number;
      command: Command;
    };
    if (command.action === "close") await Promise.all(pending);
    const task = (async () => {
      let result: Result<unknown>;
      try {
        result = { ok: true, value: await handle(command) };
      } catch (error) {
        const detail = error as {
          code?: string;
          status?: number;
          message?: string;
        };
        result = {
          ok: false,
          error: {
            code: detail.code,
            status: detail.status,
            message: detail.message?.slice(0, 300),
          },
        };
      }
      process.stdout.write(JSON.stringify({ id, result }) + "\n");
    })();
    pending.add(task);
    void task.then(() => pending.delete(task));
    if (command.action === "close") {
      await task;
      return;
    }
  }
  await Promise.all(pending);
}

async function runtimeMode() {
  // stdout is the command protocol; native runtime diagnostics belong in the
  // bounded, redacted stderr archive even when emitted outside Miniflare's logger.
  console.log = console.info = console.debug = console.error;
  const {
    Miniflare,
    convertV4MiniflareOptions,
    Log,
    LogLevel,
    Response: RuntimeResponse,
  } = runtimeRequire("miniflare") as typeof MiniflareModule;
  let mf: InstanceType<typeof Miniflare> | undefined;
  let options:
    | (MiniflareModule.V4MiniflareOptions & {
        workers: MiniflareModule.V4WorkerOptions[];
      })
    | undefined;
  let generation = 0;
  let outbound = 0;
  let fault:
    | (NonNullable<Command["fault"]> & { rootId: string; branch: string })
    | undefined;
  let hit:
    | {
        method: string;
        stage: string;
        rootId: string;
        branch: string;
        requestId: string;
        snapshotId?: number;
      }
    | undefined;
  let releasePause: (() => void) | undefined;
  let hitResolve: (() => void) | undefined;
  let hitPromise: Promise<void> = Promise.resolve();
  const control: MiniflareModule.V4FetchHandler = async (request) => {
    const call = (await request.json()) as {
      method: string;
      stage: string;
      target: { rootDropId: string; branchId: string };
      requestId: string;
      snapshotId?: number;
    };
    if (
      !fault ||
      call.method !== fault.method ||
      call.stage !== fault.stage ||
      call.target.rootDropId !== fault.rootId ||
      call.target.branchId !== fault.branch
    )
      return new RuntimeResponse(null, { status: 204 });
    const mode = fault.mode;
    hit = {
      method: call.method,
      stage: call.stage,
      rootId: fault.rootId,
      branch: fault.branch,
      requestId: call.requestId,
      snapshotId: call.snapshotId,
    };
    fault = undefined;
    hitResolve?.();
    if (mode === "hold") await new Promise<void>(() => {});
    if (mode === "pause") {
      await new Promise<void>((resume) => {
        releasePause = resume;
      });
      releasePause = undefined;
      return new RuntimeResponse(null, { status: 204 });
    }
    if (mode === "stale-generation")
      return new RuntimeResponse(null, {
        status: 204,
        headers: { "x-fixture-stale-generation": "1" },
      });
    return new RuntimeResponse(null, { status: 503 });
  };
  await serveCommands(async (command) => {
    if (command.action === "configure") {
      options = {
        rootPath: root,
        modulesRoot: evidence,
        resourcePersistencePath: resolve(evidence, "native-state"),
        resourceTmpPath: resolve(evidence, `runtime-${process.pid}`),
        host: "127.0.0.1",
        port: 0,
        cf: false,
        telemetry: { enabled: false },
        log: new Log(LogLevel.NONE),
        unsafeInspectDurableObjects: true,
        workers: [
          {
            name: "application",
            modulesRoot: evidence,
            modules: [
              {
                type: "ESModule",
                path: resolve(evidence, "application-worker.mjs"),
              },
            ],
            compatibilityDate,
            bindings: {
              ACCOUNT_AUTH_SECRET: command.secret!,
              PROVIDER_ENCRYPTION_PRIVATE_JWK: JSON.stringify(
                command.providerPrivateJwk,
              ),
            },
            r2Buckets: { R2_BUCKET: "acceptance-r2" },
            d1Databases: { DB: "acceptance-auth" },
            serviceBindings: {
              FIXTURE_CONTROL: control,
              LEGACY_APPLICATION: "legacy-application",
              BRANCH_STATE_SERVICE: {
                name: "state",
                entrypoint: "BranchStateService",
              },
            },
            outboundService: () => {
              outbound++;
              throw Error("WORKER_NETWORK_DISABLED");
            },
          },
          {
            name: "state",
            modulesRoot: evidence,
            modules: [
              { type: "ESModule", path: resolve(evidence, "state-worker.mjs") },
            ],
            compatibilityDate,
            bindings: {
              STATE_PLANE_LOCAL_TEST: "1",
              FIXTURE_RUNTIME_GENERATION: generation,
            },
            durableObjects: {
              BRANCH_STATE: {
                className: "BranchStateObject",
                useSQLite: true,
                unsafeUniqueKey: "application-acceptance-v1",
              },
            },
            outboundService: () => {
              outbound++;
              throw Error("WORKER_NETWORK_DISABLED");
            },
          },
          {
            name: "legacy-application",
            modulesRoot: evidence,
            modules: [
              {
                type: "ESModule",
                path: resolve(evidence, "application-worker.mjs"),
              },
            ],
            compatibilityDate,
            bindings: {
              ACCOUNT_AUTH_SECRET: command.secret!,
              PROVIDER_ENCRYPTION_PRIVATE_JWK: JSON.stringify(
                command.providerPrivateJwk,
              ),
              FIXTURE_LEGACY_COMPOSITION: "1",
            },
            r2Buckets: { R2_BUCKET: "acceptance-r2" },
            d1Databases: { DB: "acceptance-auth" },
            serviceBindings: {
              FIXTURE_CONTROL: control,
              BRANCH_STATE_SERVICE: {
                name: "state",
                entrypoint: "BranchStateService",
              },
            },
            outboundService: () => {
              outbound++;
              throw Error("WORKER_NETWORK_DISABLED");
            },
          },
        ],
      };
      mf = new Miniflare(convertV4MiniflareOptions(options));
      console.error(
        JSON.stringify({
          event: "fixture.runtime.address",
          action: command.action,
          pid: process.pid,
          baseUrl: (await mf.ready).origin,
        }),
      );
      return { baseUrl: (await mf.ready).origin, pid: process.pid };
    }
    assert.ok(mf, "runtime configured");
    if (command.action === "arm-rpc-fault") {
      assert.ok(command.fault && command.rootId && command.branch);
      assert.equal(
        releasePause,
        undefined,
        "previous fixture barrier must be released",
      );
      fault = {
        ...command.fault,
        rootId: command.rootId,
        branch: command.branch,
      };
      hit = undefined;
      hitPromise = new Promise<void>((resolveHit) => {
        hitResolve = resolveHit;
      });
      return { armed: true };
    }
    if (command.action === "release-rpc-fault") {
      assert.ok(releasePause, "fixture pause is active");
      releasePause();
      return { released: true };
    }
    if (command.action === "wait-rpc-fault") {
      await bounded(
        hitPromise,
        requestDeadlineMs / 2,
        "RPC fault barrier not reached",
      );
      assert.ok(hit);
      return hit;
    }
    if (command.action === "close") {
      await mf.dispose();
      return { outbound };
    }
    if (command.action === "outbound-count") return { outbound };
    if (command.action === "state-http")
      return {
        status: (
          await (await mf.getWorker("state")).fetch("https://state.invalid/")
        ).status,
      };
    if (command.action === "setup-authoring") {
      const db = await mf.getD1Database("DB", "application");
      const migrations = readdirSync(resolve(root, "migrations"))
        .filter((name) => name.endsWith(".sql"))
        .sort();
      const pinned = (
        JSON.parse(
          readFileSync(
            resolve(evidence, "application-source-pins.json"),
            "utf8",
          ),
        ) as {
          inputs: Record<string, string>;
        }
      ).inputs;
      const migrationPaths = migrations
        .map((name) => realpathSync(resolve(root, "migrations", name)))
        .sort();
      assert.deepEqual(
        migrationPaths,
        Object.keys(pinned)
          .filter((path) =>
            path.startsWith(realpathSync(resolve(root, "migrations")) + "/"),
          )
          .sort(),
        "migration set matches pre-compilation pins",
      );
      const setup = {
        migrations: [] as string[],
        d1ExecCalls: 0,
        d1StatementWrites: 0,
        r2Calls: 0,
      };
      // This command runs once per fresh evidence directory, after the baseline.
      // One line per whole migration preserves trigger bodies with embedded semicolons.
      for (const name of migrations) {
        const path = realpathSync(resolve(root, "migrations", name));
        const source = readFileSync(path, "utf8");
        assert.equal(
          sha256(source),
          pinned[path],
          "migration source pinned before execution",
        );
        const sql = source
          .replace(/--[^\n]*/g, "")
          .split("\n")
          .join(" ");
        setup.d1ExecCalls++;
        await db.exec(sql);
        setup.migrations.push(name);
      }
      const account = command.account!;
      setup.d1StatementWrites++;
      await db
        .prepare(
          `INSERT INTO accounts
        (account_id, signing_public_jwk, encryption_kid, encryption_public_jwk, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          account.accountId,
          JSON.stringify(account.signingPublicJwk),
          "acceptance-account",
          JSON.stringify(account.encryptionPublicJwk),
          1700000000000,
          1700000000000,
        )
        .run();
      return setup;
    }
    if (command.action === "inspect-root") {
      assert.ok(command.rootId);
      const db = await mf.getD1Database("DB", "application");
      const bucket = await mf.getR2Bucket("R2_BUCKET", "application");
      const object = await bucket.get(command.rootId);
      const raw = await object?.text();
      const envelope = raw ? decodeDropEnvelope(JSON.parse(raw)) : null;
      const projection = await db
        .prepare(
          "SELECT account_id,visibility,deleted_at FROM account_library_entries WHERE drop_id=?",
        )
        .bind(command.rootId)
        .first<NonNullable<RootInspection["projection"]>>();
      const row = await db
        .prepare("SELECT COUNT(*) AS n FROM branches WHERE root_drop_id=?")
        .bind(command.rootId)
        .first<{ n: number }>();
      return {
        exists: object !== null,
        ...(raw
          ? inspectApplicationRootStorage(raw, command.content)
          : {
              sealed: false,
              containsPlaintext: false,
              unexpectedFields: [],
            }),
        accountId: envelope?.accountId,
        visibility: envelope?.visibility,
        revision: object?.etag,
        projection,
        legacyBranches: row?.n ?? 0,
      } satisfies RootInspection;
    }
    const query = {
      target: {
        rootDropId: command.rootId ?? fixture.root,
        branchId: command.branch ?? fixture.branch,
      },
      placement: { ...fixture.placement },
    };
    const name = await branchStateShardName(query);
    if (command.action === "seed") {
      assert.ok(
        !applicationUnseededRoots.includes(query.target.rootDropId),
        "lifecycle roots cannot be fixture seeded",
      );
      const seed = applicationSeed(
        command.branch,
        command.rootId,
        command.content,
      );
      const namespace = await mf.getDurableObjectNamespace(
        "BRANCH_STATE",
        "state",
      );
      const stub = namespace.get(namespace.idFromName(name)) as unknown as {
        seedLocalFixtures(
          seeds: ReturnType<typeof applicationSeed>[],
        ): Promise<BranchStateRpcResult<{ seeded: number }>>;
      };
      decodeBranchStateRpcResult(await stub.seedLocalFixtures([seed]));
      const db = await mf.getD1Database("DB", "application");
      const migration = readFileSync(
        resolve(root, "migrations/0012_account_remote_library.sql"),
        "utf8",
      );
      // Execute individual statements: D1 exec's line splitting is not a migration parser.
      for (const statement of migration
        .replace(/^--.*$/gm, "")
        .split(";")
        .filter((part) => part.trim()))
        await db.prepare(statement).run();
      await db
        .prepare(
          "INSERT OR IGNORE INTO account_library_entries (drop_id,account_id,visibility,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,NULL)",
        )
        .bind(
          seed.branch.rootDropId,
          fixture.owner,
          seed.branch.rootDropId === fixture.publicRoot ? "public" : "private",
          1000,
          1000,
        )
        .run();
      return { seeded: true };
    }
    if (command.action === "reset-runtime") {
      assert.ok(options && "workers" in options);
      generation++;
      options.workers[1].bindings = {
        STATE_PLANE_LOCAL_TEST: "1",
        FIXTURE_RUNTIME_GENERATION: generation,
      };
      await mf.setOptions(convertV4MiniflareOptions(options));
      return {
        reset: true,
        generation,
        baseUrl: (await mf.ready).origin,
        pid: process.pid,
      };
    }
    if (
      command.action === "arm-sql-fault" ||
      command.action === "clear-sql-fault"
    ) {
      const storage = await mf.unsafeGetDurableObjectStorage(
        "state",
        "BranchStateObject",
        { name },
      );
      if (command.action === "arm-sql-fault") {
        await storage.exec(`CREATE TRIGGER acceptance_later_event_abort BEFORE INSERT ON branch_events
          WHEN NEW.event_id = '"rollback-second"'
          BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_BATCH_ABORT'); END`);
      } else await storage.exec("DROP TRIGGER acceptance_later_event_abort");
      return { armed: command.action === "arm-sql-fault" };
    }
    if (
      command.action === "inspect-runtime-facts" ||
      command.action === "arm-runtime-fact-sql-fault" ||
      command.action === "clear-runtime-fact-sql-fault"
    ) {
      assert.ok(applicationRuntimeRoots.includes(query.target.rootDropId));
      const storage = await mf.unsafeGetDurableObjectStorage(
        "state",
        "BranchStateObject",
        { name },
      );
      if (command.action === "arm-runtime-fact-sql-fault") {
        await storage.exec(`CREATE TRIGGER acceptance_runtime_fact_abort AFTER INSERT ON branch_runtime_fact_outbox
          WHEN json_extract(NEW.outbox_json, '$.receipt.event.fact.id') = 'native-fact-rollback'
          BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_RUNTIME_FACT_ABORT'); END`);
        return { armed: true };
      }
      if (command.action === "clear-runtime-fact-sql-fault") {
        await storage.exec("DROP TRIGGER acceptance_runtime_fact_abort");
        return { armed: false };
      }
      const scope = [
        JSON.stringify(query.target.rootDropId),
        JSON.stringify(query.target.branchId),
      ];
      const counts: Record<string, number> = {};
      for (const table of [
        "branch_runtime_fact_heads",
        "branch_runtime_facts",
        "branch_runtime_fact_receipts",
        "branch_runtime_fact_outbox",
      ])
        counts[table] = (
          await storage.exec<{ n: number }>(
            `SELECT COUNT(*) AS n FROM ${table} WHERE root_drop_id=? AND branch_id=?`,
            ...scope,
          )
        )[0].n;
      const heads = await storage.exec<{ head_seq: number }>(
        "SELECT head_seq FROM branch_runtime_fact_heads WHERE root_drop_id=? AND branch_id=?",
        ...scope,
      );
      return {
        counts,
        headSeq: heads[0]?.head_seq ?? -1,
        facts: (
          await storage.exec<{ event_json: string }>(
            "SELECT event_json FROM branch_runtime_facts WHERE root_drop_id=? AND branch_id=? ORDER BY seq",
            ...scope,
          )
        ).map((row) => JSON.parse(row.event_json) as DropBranchRuntimeFact),
        receipts: (
          await storage.exec<{ receipt_json: string }>(
            "SELECT receipt_json FROM branch_runtime_fact_receipts WHERE root_drop_id=? AND branch_id=? ORDER BY identity",
            ...scope,
          )
        )
          .map(
            (row) => JSON.parse(row.receipt_json) as BranchRuntimeFactReceipt,
          )
          .sort((a, b) => a.event.seq - b.event.seq),
        outbox: (
          await storage.exec<{ outbox_json: string }>(
            "SELECT outbox_json FROM branch_runtime_fact_outbox WHERE root_drop_id=? AND branch_id=? ORDER BY identity",
            ...scope,
          )
        )
          .map((row) => JSON.parse(row.outbox_json) as BranchRuntimeFactOutbox)
          .sort((a, b) => a.receipt.event.seq - b.receipt.event.seq),
      } satisfies RuntimeFactInspection;
    }
    if (command.action === "inspect") {
      console.error(
        JSON.stringify({
          event: "fixture.runtime.address",
          action: command.action,
          pid: process.pid,
          baseUrl: (await mf.ready).origin,
        }),
      );
      const storage = await mf.unsafeGetDurableObjectStorage(
        "state",
        "BranchStateObject",
        { name },
      );
      const scope = [
        JSON.stringify(query.target.rootDropId),
        JSON.stringify(query.target.branchId),
      ];
      const counts: Record<string, number> = {};
      for (const table of [
        "branch_heads",
        "branch_snapshots",
        "branch_events",
        "branch_receipts",
        "branch_outbox",
      ])
        counts[table] = (
          await storage.exec<{ n: number }>(
            `SELECT COUNT(*) AS n FROM ${table} WHERE root_drop_id=? AND branch_id=?`,
            ...scope,
          )
        )[0].n;
      return {
        counts,
        ...(applicationUnseededRoots.includes(query.target.rootDropId)
          ? await (async () => {
              const rows = await storage.exec<{
                authority_json: string;
                initialization_receipt_json: string | null;
              }>(
                "SELECT authority_json,initialization_receipt_json FROM branch_authorities WHERE root_drop_id=? AND branch_id=?",
                ...scope,
              );
              return {
                authority: rows[0]
                  ? (JSON.parse(
                      rows[0].authority_json,
                    ) as BranchAuthorityRecord)
                  : null,
                initializationReceipt: rows[0]?.initialization_receipt_json
                  ? (JSON.parse(
                      rows[0].initialization_receipt_json,
                    ) as BranchInitializationReceipt)
                  : null,
              };
            })()
          : {}),
        events: await storage.exec(
          "SELECT event_id,event_seq,snapshot_id FROM branch_events WHERE root_drop_id=? AND branch_id=? ORDER BY event_seq",
          ...scope,
        ),
        receipts: (
          await storage.exec<{ receipt_json: string }>(
            "SELECT receipt_json FROM branch_receipts WHERE root_drop_id=? AND branch_id=? ORDER BY event_id",
            ...scope,
          )
        ).map((row) => JSON.parse(row.receipt_json)),
        outbox: (
          await storage.exec<{ outbox_json: string }>(
            "SELECT outbox_json FROM branch_outbox WHERE root_drop_id=? AND branch_id=? ORDER BY event_id",
            ...scope,
          )
        ).map((row) => JSON.parse(row.outbox_json)),
      } satisfies Inspection;
    }
    throw Error("Unknown runtime command");
  });
}

async function clientMode() {
  let client: NulldownClient | undefined;
  let visibility: DropVisibility = "unlisted";
  let cursor = "-1",
    factCursor: string | undefined,
    serial = 0,
    clientId = "",
    loseNextAck = false;
  await serveCommands(async (command) => {
    if (command.action === "configure") {
      clientId = command.clientId!;
      cursor = command.cursor ?? "-1";
      factCursor = command.factCursor ?? undefined;
      const material = command.authoring;
      const authoring = material
        ? {
            encryptionPublicKey: await crypto.subtle.importKey(
              "jwk",
              material.encryptionPublicJwk,
              { name: "RSA-OAEP", hash: "SHA-256" },
              false,
              ["encrypt"],
            ),
            signingPrivateKey: await crypto.subtle.importKey(
              "jwk",
              material.signingPrivateJwk,
              { name: "ECDSA", namedCurve: "P-256" },
              false,
              ["sign"],
            ),
            providerPublicKey: await crypto.subtle.importKey(
              "jwk",
              material.providerPublicJwk,
              { name: "RSA-OAEP", hash: "SHA-256" },
              false,
              ["encrypt"],
            ),
          }
        : undefined;
      const fetchImpl: typeof fetch = Object.assign(
        (
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => {
          const headers = new Headers(init?.headers);
          headers.set(
            "x-acceptance-request",
            `${clientId}-${process.pid}-${++serial}`,
          );
          headers.set("x-request-id", headers.get("x-acceptance-request")!);
          if (loseNextAck) {
            headers.set("x-acceptance-lose-ack", "1");
            loseNextAck = false;
          }
          return fetch(input, { ...init, headers });
        },
        {
          preconnect: () => {
            throw Error("HOST_NETWORK_DISABLED");
          },
        },
      );
      client = createNulldownClient({
        baseUrl: command.baseUrl!,
        token: command.token ?? null,
        clientId,
        accountId: null,
        diffAuthToken: null,
        diffWebhookSecret: null,
        requestTimeoutMs: requestDeadlineMs,
        fetch: fetchImpl,
        envelopeProvider:
          material && authoring
            ? {
                seal: ({ content, metadata }) =>
                  sealDropForAuthoring({
                    payload: { content, metadata },
                    accountEncryption: {
                      accountId: material.accountId,
                      encryptionKid: "acceptance-account",
                      encryptionPublicJwk: material.encryptionPublicJwk,
                      encryptionPublicKey: authoring.encryptionPublicKey,
                    },
                    delegateSigning: {
                      signingKid: "acceptance-device",
                      signingPublicJwk: material.signingPublicJwk,
                      signingPrivateKey: authoring.signingPrivateKey,
                    },
                    providerEncryption: {
                      kid: "acceptance-provider",
                      publicKey: authoring.providerPublicKey,
                    },
                    visibility,
                    unlockPolicy: "provider-escrow",
                    metadata,
                  }),
              }
            : undefined,
      });
      return { pid: process.pid };
    }
    if (command.action === "close") return { closed: true, cursor, factCursor };
    assert.ok(client, "client configured");
    if (command.action === "store-state") {
      assert.ok(command.stateFact);
      loseNextAck = command.loseAck ?? false;
      return client.storeNullplugState(command.stateFact);
    }
    if (command.action === "submit-response") {
      assert.ok(command.responseFact);
      loseNextAck = command.loseAck ?? false;
      return client.submitNullplugResponse(command.responseFact);
    }
    if (command.action === "create-root") {
      visibility = command.visibility ?? "unlisted";
      assert.ok(command.create);
      return client.createDrop(command.create);
    }
    if (command.action === "resolve") {
      loseNextAck = command.loseAck ?? false;
      return client.resolveBranch(command.rootId!);
    }
    if (command.action === "root") return client.getDrop(command.rootId!);
    if (
      command.action === "snapshots" ||
      (command.action === "content" && command.snapshotId !== undefined)
    ) {
      const rootId = encodeURIComponent(command.rootId ?? fixture.root);
      const branchId = encodeURIComponent(
        command.branch ?? fixture.branch,
      ).replace(/%3A/gi, ":");
      const path = `/api/branches/${rootId}/${branchId}/${command.action === "snapshots" ? "snapshots" : `content?snapshotId=${command.snapshotId}`}`;
      const result = (await client.request(path)).data;
      assert.ok(
        command.action === "snapshots"
          ? isDropSnapshotListResponse(result)
          : isDropBranchContentResponse(result),
      );
      return result;
    }
    if (command.action === "apply") {
      const event = command.event!;
      // Fault selection is transport-only; the SDK still constructs and validates its actual receipt.
      loseNextAck = command.loseAck ?? false;
      return client.applyDiff({
        dropId: event.dropId,
        branchId: command.branch ?? fixture.branch,
        eventId: event.eventId,
        createdAt: event.createdAt,
        ops: event.ops,
        metadata: event.metadata,
      });
    }
    if (command.action === "batch")
      return (
        await client.request<DropDiffAppendResponse>(
          diffPath(command.branch, command.rootId),
          {
            method: "POST",
            headers: { "Content-Type": "application/json", ...command.headers },
            body: JSON.stringify({ version: 1, events: command.events }),
          },
        )
      ).data;
    if (command.action === "content")
      return client.getBranchContent(
        command.rootId ?? fixture.root,
        command.branch ?? fixture.branch,
      );
    if (command.action === "poll") {
      const params = new URLSearchParams({
        branchId: command.branch ?? fixture.branch,
        cursor: command.cursor ?? cursor,
      });
      if (command.limit !== undefined)
        params.set("limit", String(command.limit));
      const requestedFactCursor =
        command.factCursor === null
          ? undefined
          : (command.factCursor ?? factCursor);
      if (requestedFactCursor !== undefined)
        params.set("factCursor", requestedFactCursor);
      if (command.factLimit !== undefined)
        params.set("factLimit", String(command.factLimit));
      if (command.excludeClient !== undefined)
        params.set("excludeClient", command.excludeClient);
      const result = (
        await client.request<DropDiffPollResponse>(
          `/api/diff/${command.rootId ?? fixture.root}?${params}`,
        )
      ).data!;
      if (result.cursor !== null) cursor = result.cursor;
      if (result.factCursor != null) factCursor = result.factCursor;
      return result;
    }
    if (command.action === "request")
      return (
        await client.request(command.path!, {
          method: command.method ?? "GET",
          headers: command.headers,
          ...(command.json
            ? { body: JSON.stringify(command.json) }
            : command.events
              ? { body: JSON.stringify({ version: 1, events: command.events }) }
              : {}),
        })
      ).data;
    throw Error("Unknown client command");
  });
}

interface RequestRecord extends ApplicationRequestEvidence {
  lostAck: boolean;
  bodyHash: string;
  failureCode?: string;
}
async function relay(upstream: () => string, records: RequestRecord[]) {
  let lostResponse: unknown;
  const interrupted: {
    requestId: string;
    reason: "upstream_transport_failure";
    transportCode?: string;
    transportMessage: string;
  }[] = [];
  const server: Server = createServer((incoming, outgoing) => {
    let forwarded = false;
    const upstreamOrigin = upstream();
    void (async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        assert.ok(size <= 2000000, "bounded synthetic HTTP request");
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [name, contents] of Object.entries(incoming.headers)) {
        if (
          [
            "host",
            "connection",
            "content-length",
            "transfer-encoding",
          ].includes(name) ||
          contents === undefined
        )
          continue;
        headers.set(
          name,
          Array.isArray(contents) ? contents.join(", ") : contents,
        );
      }
      const loseAck = headers.get("x-acceptance-lose-ack") === "1";
      headers.delete("x-acceptance-lose-ack");
      forwarded = true;
      const response = await fetch(new URL(incoming.url!, upstreamOrigin), {
        method: incoming.method,
        headers,
        ...(body.length ? { body } : {}),
        signal: AbortSignal.timeout(requestDeadlineMs),
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      forwarded = false;
      assert.ok(bytes.byteLength < 2000000, "bounded synthetic HTTP response");
      const report = response.headers.get("x-state-plane-evidence");
      assert.ok(report, "application request evidence present");
      const record: RequestRecord = {
        ...JSON.parse(report),
        lostAck: loseAck,
        bodyHash: sha256(body),
      };
      if (!response.ok) {
        let code: unknown;
        try {
          code = (
            JSON.parse(new TextDecoder().decode(bytes)) as { code?: unknown }
          ).code;
        } catch {
          /* Existing plain-text errors retain their public contract. */
        }
        record.failureCode =
          typeof code === "string" && /^[a-z][a-z0-9_]{0,80}$/.test(code)
            ? code
            : "http_error";
      }
      records.push(record);
      appendFileSync(
        resolve(evidence, "application-requests.ndjson"),
        JSON.stringify(record) + "\n",
      );
      if (loseAck) {
        assert.equal(
          response.status,
          200,
          "only discard a confirmed postcommit response",
        );
        lostResponse = JSON.parse(new TextDecoder().decode(bytes));
        outgoing.destroy();
        return;
      }
      const responseHeaders: Record<string, string> = {
        "Content-Type": response.headers.get("content-type") ?? "text/plain",
      };
      for (const name of ["etag", "x-drop-canonical-id", "x-drop-revision"]) {
        const value = response.headers.get(name);
        if (value) responseHeaders[name] = value;
      }
      outgoing.writeHead(response.status, responseHeaders);
      outgoing.end(bytes);
    })().catch((error: unknown) => {
      if (forwarded)
        interrupted.push({
          requestId: String(
            incoming.headers["x-acceptance-request"] ?? "unknown",
          ),
          reason: "upstream_transport_failure",
          transportCode: (error as { cause?: { code?: string } })?.cause?.code,
          transportMessage: redact(
            String((error as { cause?: unknown })?.cause ?? error),
          ).slice(0, 300),
        });
      // Failure must become an assertion, never an apparently successful unmeasured request.
      outgoing.writeHead(502, { "Content-Type": "text/plain" });
      outgoing.end(
        error instanceof Error ? error.message : "Fixture relay failed",
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    lostReceipt: () => lostResponse as DropDiffAppendResponse | undefined,
    lostResponse: () => lostResponse,
    interrupted,
    async close() {
      server.closeAllConnections();
      await bounded(
        new Promise<void>((yes, no) =>
          server.close((error) => (error ? no(error) : yes())),
        ),
        shutdownDeadlineMs,
        "Relay close deadline",
      );
    },
  };
}

async function main() {
  const esbuild = require("esbuild") as {
    build(options: BuildOptions): Promise<BuildResult>;
  };
  const sourcePins = JSON.parse(
    readFileSync(resolve(evidence, "application-source-pins.json"), "utf8"),
  ) as {
    bunVersion: string;
    graphs: {
      driver: string[];
      cli: string[];
      state: string[];
      application: string[];
    };
    inputs: Record<string, string>;
    driverBundleHash: string;
    protocol: string;
  };
  const inputs = new Map(Object.entries(sourcePins.inputs));
  const drift = (entries: Iterable<[string, string]>) =>
    [...entries]
      .filter(([path, digest]) => {
        try {
          return sha256(readFileSync(path)) !== digest;
        } catch {
          return true;
        }
      })
      .map(([path]) => path);
  assert.deepEqual(drift(inputs), [], "launcher input pins still match");
  assert.equal(sourcePins.protocol, "discover-discard-pin-compile-verify-v1");
  assert.equal(
    sha256(readFileSync(process.argv[1])),
    sourcePins.driverBundleHash,
    "executed driver hash",
  );
  for (const [entry, output, graph] of [
    [
      "packages/nulldown-state-plane/src/worker.ts",
      "state-worker.mjs",
      "state",
    ],
    [
      "packages/nulldown-state-plane/test/application-worker.fixture.ts",
      "application-worker.mjs",
      "application",
    ],
  ] as const) {
    assert.deepEqual(
      drift(inputs),
      [],
      "all sources pinned before Worker compilation",
    );
    const built = await esbuild.build({
      absWorkingDir: root,
      entryPoints: [entry],
      outfile: resolve(evidence, output),
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      external: ["cloudflare:workers"],
      metafile: true,
    });
    const actual = Object.keys(built.metafile!.inputs)
      .map((input) => realpathSync(resolve(root, input)))
      .sort();
    assert.deepEqual(
      actual,
      sourcePins.graphs[graph],
      "Worker dependency set matches pre-compilation discovery",
    );
    for (const path of actual)
      assert.ok(inputs.has(path), "new unpinned Worker input rejected");
    assert.deepEqual(
      drift(inputs),
      [],
      "all source hashes unchanged after Worker compilation",
    );
  }
  const pins = {
    protocol: sourcePins.protocol,
    sourceGraphs: sourcePins.graphs,
    bunVersion: sourcePins.bunVersion,
    node: process.version,
    compatibilityDate,
    lockSha256: sha256(readFileSync(resolve(root, "bun.lock"))),
    dependencies: ["miniflare", "workerd", "wrangler"].map((name) => ({
      name,
      version: runtimeRequire(name + "/package.json").version,
    })),
    inputs: Object.fromEntries(inputs),
    bundles: Object.fromEntries(
      [
        "state-worker.mjs",
        "application-worker.mjs",
        "application-acceptance.mjs",
      ].map((name) => [name, sha256(readFileSync(resolve(evidence, name)))]),
    ),
  };
  writeFileSync(
    resolve(evidence, "application-premeasurement.json"),
    JSON.stringify(
      {
        pins,
        budgets: {
          requestDeadlineMs,
          baselineAndSteadyState: { wholeRequestR2: 0, sqlWrites: 0 },
          rootCreationAndBootstrap:
            "measured separately; no zero dependency claim",
          processWideOutbound: 0,
          shutdownDeadlineMs,
          harnessDeadlineMs,
        },
        expectedContent: fixture,
        scope:
          "synthetic local HTTP/application/service-binding/native SQLite; no production or outbox delivery claim",
      },
      null,
      2,
    ),
  );
  const secret = randomBytes(32).toString("hex");
  const [signing, encryption, provider] = await Promise.all([
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]),
    crypto.subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["encrypt", "decrypt"],
    ),
    crypto.subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["encrypt", "decrypt"],
    ),
  ]);
  const authoring: AuthoringKeys = {
    accountId: lifecycle.owner,
    signingPublicJwk: await crypto.subtle.exportKey("jwk", signing.publicKey),
    signingPrivateJwk: await crypto.subtle.exportKey("jwk", signing.privateKey),
    encryptionPublicJwk: await crypto.subtle.exportKey(
      "jwk",
      encryption.publicKey,
    ),
    providerPublicJwk: await crypto.subtle.exportKey("jwk", provider.publicKey),
  };
  const recipient = await canonicalizeAccountEncryptionRecipient({
    encryptionKid: "acceptance-account",
    encryptionPublicJwk: authoring.encryptionPublicJwk,
  });
  assert.ok(recipient, "synthetic account encryption recipient is canonical");
  authoring.encryptionPublicJwk = recipient.encryptionPublicJwk;
  const providerPrivateJwk = await crypto.subtle.exportKey(
    "jwk",
    provider.privateKey,
  );
  registerPrivateJwk(authoring.signingPrivateJwk);
  registerPrivateJwk(providerPrivateJwk);
  const tokens = await Promise.all(
    [
      fixture.owner,
      fixture.writer,
      fixture.stranger,
      lifecycle.owner,
      lifecycle.writer,
      lifecycle.otherWriter,
    ].map(
      async (id) =>
        (await issueAccountSessionToken(id, { ACCOUNT_AUTH_SECRET: secret }))
          .token,
    ),
  );
  for (const value of [secret, ...tokens]) sensitiveValues.add(value);
  const records: RequestRecord[] = [];
  const checks: {
    name: string;
    workload: "baseline" | "lifecycle" | "runtime-facts";
    passed: boolean;
    ms: number;
    error?: string;
  }[] = [];
  let workload: "baseline" | "lifecycle" | "runtime-facts" = "baseline";
  const expectedGroups = { baseline: 13, lifecycle: 8, "runtime-facts": 8 };
  const completeGroups = () =>
    Object.entries(expectedGroups).every(
      ([name, count]) =>
        checks.filter((check) => check.workload === name).length === count,
    );
  const pids: number[] = [];
  let runtime = new Peer("runtime"),
    a = new Peer("client"),
    b = new Peer("client");
  let upstream = "";
  const proxy = await relay(() => upstream, records);
  const run = async (name: string, operation: () => Promise<void>) => {
    const start = performance.now();
    try {
      await operation();
      checks.push({
        name,
        workload,
        passed: true,
        ms: performance.now() - start,
      });
      console.log("PASS", name);
    } catch (error) {
      checks.push({
        name,
        workload,
        passed: false,
        ms: performance.now() - start,
        error: redact(String(error)).slice(0, 1000),
      });
      console.error("FAIL", name, redact(String(error)));
    }
  };
  const startRuntime = async () => {
    const started = value(
      await runtime.call<{ baseUrl: string; pid: number }>({
        action: "configure",
        secret,
        providerPrivateJwk,
      }),
    );
    upstream = started.baseUrl;
    pids.push(started.pid);
  };
  const configure = async (
    peer: Peer,
    token: string | undefined,
    clientId: string,
    cursor?: string,
    keys?: AuthoringKeys,
    baseSuffix = "",
  ) =>
    value(
      await peer.call({
        action: "configure",
        token,
        clientId,
        baseUrl: proxy.baseUrl + baseSuffix,
        cursor,
        authoring: keys,
      }),
    );
  const seed = async (branch?: string, content?: string, rootId?: string) =>
    value(await runtime.call({ action: "seed", branch, content, rootId }));
  const inspect = async (branch?: string, rootId?: string) =>
    value(
      await runtime.call<Inspection>({ action: "inspect", branch, rootId }),
    );
  const inspectRoot = async (rootId: string) =>
    value(
      await runtime.call<RootInspection>({ action: "inspect-root", rootId }),
    );
  const resolveBranch = async (peer: Peer, rootId: string) =>
    value(
      await peer.call<DropBranchResolveResponse>({ action: "resolve", rootId }),
    );
  const lifecycleContent = async (
    peer: Peer,
    rootId: string,
    branch = "owner",
    snapshotId?: number,
  ) =>
    value(
      await peer.call<DropBranchContentResponse>({
        action: "content",
        rootId,
        branch,
        snapshotId,
      }),
    );
  const lifecycleHistory = async (
    peer: Peer,
    rootId: string,
    branch = "owner",
  ) =>
    value(
      await peer.call<DropSnapshotListResponse>({
        action: "snapshots",
        rootId,
        branch,
      }),
    );
  const armFault = async (
    rootId: string,
    method: NonNullable<Command["fault"]>["method"],
    mode: NonNullable<Command["fault"]>["mode"] = "fail",
    stage: "before" | "after" = method === "readPlacement" ||
    method === "readHead"
      ? "before"
      : "after",
  ) =>
    value(
      await runtime.call({
        action: "arm-rpc-fault",
        rootId,
        branch: "owner",
        fault: {
          method,
          stage,
          mode,
        },
      }),
    );
  const assertRootWritesRejected = async (rootId: string) => {
    const before = await inspectRoot(rootId);
    const offset = records.length;
    await rejected(
      a,
      {
        action: "create-root",
        create: {
          id: rootId,
          upsert: true,
          expectedRevision: before.revision,
          content: "must not replace root\n",
        },
      },
      501,
      "capability_unsupported",
    );
    await rejected(
      a,
      { action: "request", path: `/api/delete/${rootId}`, method: "DELETE" },
      501,
      "capability_unsupported",
    );
    for (const action of ["publish", "promote"]) {
      await rejected(
        a,
        {
          action: "request",
          path: `/api/branches/${rootId}/owner/${action}`,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          json: {
            expectedSnapshotId: 0,
            idempotencyKey: `unsupported-${action}`,
            ...(action === "publish"
              ? { expectedRevision: before.revision! }
              : {}),
          },
        },
        501,
        "capability_unsupported",
      );
    }
    const registration: Command = {
      action: "request",
      path: `/api/diff-auth/register/${rootId}`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      json: { clientId: "lifecycle-A" },
    };
    await rejected(a, registration, 501, "capability_unsupported");
    const unsupported: Command[] = [
      {
        action: "request",
        path: `/api/branches/${rootId}/owner/resolved/query`,
        method: "GET",
      },
      {
        action: "request",
        path: "/api/nullplug/state",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        json: {
          version: 1,
          kind: "ui.state.patch",
          id: "unsupported-patch",
          callId: "unsupported-call",
          createdAt: 123,
          source: {
            rootDropId: rootId,
            branchId: "owner",
            snapshotId: 0,
            sourceContentHash: `sha256:${createHash("sha256").update(`nulldown.source-content.v1\n${lifecycle.initial}`).digest("base64url")}`,
            callId: "unsupported-call",
          },
          patch: [{ op: "set", path: ["approved"], value: true }],
        },
      },
    ];
    for (const request of unsupported)
      await rejected(a, request, 501, "capability_unsupported");
    await configure(b, undefined, "guard-unauthenticated");
    try {
      await rejected(b, registration, 401);
      for (const request of unsupported)
        await rejected(b, request, request.method === "GET" ? 501 : 401);
    } finally {
      await configure(b, tokens[3], "lifecycle-B");
    }
    for (const row of records.slice(offset)) {
      assert.equal(row.sqlWrites, 0);
      assert.equal(
        Object.keys(row.calls).some((name) => name.startsWith("r2.")),
        false,
      );
    }
    assert.deepEqual(await inspectRoot(rootId), before);
  };
  const content = async (peer: Peer, expected: string, branch?: string) => {
    const result = value(
      await peer.call<DropBranchContentResponse>({ action: "content", branch }),
    );
    assert.equal(result.content, expected);
    return result;
  };
  const batch = async (peer: Peer, events: DropDiffEvent[], branch?: string) =>
    value(
      await peer.call<DropDiffAppendResponse>({
        action: "batch",
        events,
        branch,
      }),
    );
  const apply = async (peer: Peer, event: DropDiffEvent, branch?: string) =>
    value(
      await peer.call<DropDiffAppendResponse>({
        action: "apply",
        event,
        branch,
      }),
    );
  const rejected = async (
    peer: Peer,
    command: Command,
    status: number,
    code?: string,
  ) => {
    const result = await peer.call(command);
    assert.equal(result.ok, false, JSON.stringify(result));
    const failure = result as Failure;
    assert.equal(failure.error.status, status);
    if (code) assert.equal(failure.error.code, code);
  };
  try {
    await cleanupFaultProbes();
    await run(
      "subprocess startup, request and close hangs terminate groups and pipes",
      async () => {
        for (const probe of ["startup", "request", "close", "exit"] as const) {
          const peer = new Peer("client", probe);
          const started = performance.now();
          try {
            if (probe === "startup")
              await assert.rejects(peer.ready, /startup deadline/);
            else {
              await peer.ready;
              if (probe === "request")
                await assert.rejects(
                  peer.call({ action: "hang", secret }, 500),
                  /Subprocess deadline/,
                );
              else
                await assert.rejects(
                  peer.close(),
                  /Subprocess (deadline|close exit deadline)/,
                );
            }
          } finally {
            await peer.forceStop(`watchdog ${probe} cleanup`);
          }
          const row = shutdownEvidence.find(
            (row) => row.pid === peer.process.pid,
          )!;
          assert.deepEqual(row.signals, ["SIGTERM", "SIGKILL"]);
          assert.equal(row.exited, true);
          assert.equal(row.pipesDestroyed, true);
          assert.ok(performance.now() - started < 10000, "bounded lifecycle");
          assert.equal(managedChildren.has(peer.process.pid!), false);
          // The group includes the stubborn grandchild holding inherited pipes.
          // Allow the OS to reap it after the leader's exit notification.
          let groupCheck: ReturnType<typeof setInterval> | undefined;
          try {
            await bounded(
              new Promise<void>((resolveGone, reject) => {
                groupCheck = setInterval(() => {
                  try {
                    process.kill(-peer.process.pid!, 0);
                  } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === "ESRCH")
                      resolveGone();
                    else reject(error);
                  }
                }, 20);
              }),
              shutdownDeadlineMs,
              "Descendant group still alive",
            );
          } finally {
            clearInterval(groupCheck);
          }
          if (probe === "request") {
            const archived = readFileSync(
              resolve(evidence, "watchdog-request-stderr.log"),
              "utf8",
            );
            assert.ok(archived.includes("[redacted]"));
            assert.ok(!archived.includes(secret));
          }
        }
      },
    );
    await startRuntime();
    await Promise.all([
      configure(a, tokens[0], "client-A"),
      configure(b, tokens[1], "client-B"),
    ]);
    assert.notEqual(await a.ready, await b.ready);
    await seed();
    await seed("public", "public fixture\n", fixture.publicRoot);
    await run(
      "real bearer authentication and private/public projection permissions",
      async () => {
        await content(a, fixture.initial);
        await content(b, fixture.initial);
        const before = await inspect();
        for (const authorization of ["", "Bearer invalid"]) {
          const offset = records.length;
          await rejected(
            a,
            {
              action: "request",
              method: "POST",
              path: diffPath(),
              events: [edits.green],
              headers: {
                "Content-Type": "application/json",
                Authorization: authorization,
                "x-nulldown-account-id": fixture.owner,
              },
            },
            401,
          );
          assert.equal(records[offset].calls["rpc.appendBatch"], undefined);
        }
        const offset = records.length;
        await rejected(
          a,
          {
            action: "request",
            method: "POST",
            path: diffPath(),
            events: [edits.green],
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${tokens[2]}`,
            },
          },
          403,
          "branch_write_forbidden",
        );
        assert.equal(records[offset].calls["rpc.appendBatch"], undefined);
        for (const authorization of ["", `Bearer ${tokens[2]}`]) {
          for (const path of [
            diffPath() + "&cursor=-1",
            `/api/branches/${fixture.root}/${fixture.branch}/content`,
          ])
            await rejected(
              a,
              {
                action: "request",
                path,
                headers: { Authorization: authorization },
              },
              404,
            );
        }
        value(
          await a.call({
            action: "request",
            path: `/api/branches/${fixture.publicRoot}/public/content`,
            headers: { Authorization: "" },
          }),
        );
        value(
          await a.call({
            action: "request",
            path: diffPath("public", fixture.publicRoot) + "&cursor=-1",
            headers: { Authorization: "" },
          }),
        );
        assert.deepEqual(await inspect(), before);
      },
    );
    await run(
      "two SDK processes edit, public multi-event batch shares one snapshot",
      async () => {
        const first = await apply(a, edits.green);
        assert.equal(first.accepted, 1);
        assert.equal(first.acknowledgements[0].seq, 0);
        const polled = value(
          await b.call<DropDiffPollResponse>({ action: "poll", cursor: "-1" }),
        );
        assert.deepEqual(
          polled.events.map((event) => event.eventId),
          [edits.green.eventId],
        );
        await content(b, fixture.green);
        await apply(b, edits.second);
        await content(a, fixture.second);
        const offset = records.length;
        const result = await batch(a, edits.batch);
        assert.equal(result.accepted, 2);
        assert.deepEqual(
          result.acknowledgements.map((ack) => ack.seq),
          [2, 3],
        );
        assert.deepEqual(
          result.acknowledgements.map((ack) => ack.snapshotId),
          [3, 3],
        );
        assert.equal(result.snapshotId, 3);
        const request = records[offset];
        assert.equal(request.calls["rpc.appendBatch"].count, 1);
        assert.equal(request.observerFailures, 1);
        assert.deepEqual(
          request.observers.map((observer) => observer.id).sort(),
          ["fixture.after", "fixture.before"],
        );
        for (const observer of request.observers) {
          assert.equal(observer.snapshotId, 3);
          assert.equal(observer.parentSnapshotId, 2);
          assert.deepEqual(
            observer.eventIds,
            edits.batch.map((event) => event.eventId),
          );
          assert.equal(observer.contentHash, sha256(fixture.batch));
        }
        await content(b, fixture.batch);
      },
    );
    await run(
      "empty, duplicate, reused-ID and stale-later-event envelopes preserve atomicity",
      async () => {
        const before = await inspect();
        const empty = await batch(a, []);
        assert.equal(empty.accepted, 0);
        const replay = await batch(a, edits.batch);
        assert.equal(replay.accepted, 0);
        assert.equal(replay.deduplicated, 2);
        assert.deepEqual(
          replay.acknowledgements.map((ack) => ack.status),
          ["duplicate", "duplicate"],
        );
        const fresh = applicationEvent(
          "never-prefix",
          [{ type: "insert", start: 0, end: 0, text: "BAD" }],
          3,
        );
        const reused = {
          ...edits.green,
          ops: [
            { type: "insert" as const, start: 0, end: 0, text: "different" },
          ],
        };
        // Existing public route intentionally retains a plain-text reused-ID response.
        await rejected(
          a,
          { action: "batch", events: [fresh, reused] },
          409,
          "http_error",
        );
        await rejected(
          a,
          {
            action: "batch",
            events: [
              fresh,
              applicationEvent(
                "stale-later",
                [{ type: "insert", start: 0, end: 0, text: "BAD" }],
                -1,
              ),
            ],
          },
          409,
          "diff_predecessor_mismatch",
        );
        assert.deepEqual(await inspect(), before);
        await content(a, fixture.batch);
        const target = "mixed";
        await seed(target, "");
        const one = applicationEvent("mixed-one", [
          { type: "insert", start: 0, end: 0, text: "a" },
        ]);
        const two = applicationEvent("mixed-two", [
          { type: "insert", start: 1, end: 1, text: "b" },
        ]);
        await batch(a, [one], target);
        const mixed = await batch(a, [one, two, two], target);
        assert.equal(mixed.accepted, 1);
        assert.equal(mixed.deduplicated, 2);
        await content(b, "ab", target);
        assert.equal((await inspect(target)).counts.branch_events, 2);
      },
    );
    await run(
      "postcommit socket loss, intervening edit and same-command retry retain original acknowledgement",
      async () => {
        const failed = await a.call({
          action: "apply",
          event: edits.saved,
          loseAck: true,
        });
        assert.equal(
          failed.ok,
          false,
          "client cannot observe discarded HTTP receipt",
        );
        const committed = proxy.lostReceipt();
        assert.ok(committed);
        assert.equal(committed.accepted, 1);
        await content(b, fixture.saved);
        await apply(b, edits.later);
        const result = await apply(a, edits.saved);
        assert.equal(result.accepted, 0);
        assert.equal(result.deduplicated, 1);
        assert.deepEqual(
          result.acknowledgements,
          committed.acknowledgements.map((ack) => ({
            ...ack,
            status: "duplicate",
          })),
        );
        const lost = records.find((record) => record.lostAck)!;
        assert.equal(
          lost.bodyHash,
          records.at(-1)!.bodyHash,
          "retry body bytes are identical",
        );
        assert.equal(
          records.at(-1)!.observers.length,
          0,
          "duplicate cannot rerun observers",
        );
        await content(a, fixture.final);
        assert.equal((await inspect()).counts.branch_events, 6);
      },
    );
    await run(
      "poll reconnect retains cursor, exact events and literal content",
      async () => {
        const first = value(
          await b.call<DropDiffPollResponse>({
            action: "poll",
            cursor: "-1",
            limit: 2,
          }),
        );
        assert.deepEqual(
          first.events.map((event) => event.eventId),
          ["edit-green", "edit-second"],
        );
        assert.equal(first.cursor, "1");
        const oldPid = await b.ready;
        await b.close();
        b = new Peer("client");
        await configure(b, tokens[1], "client-B", first.cursor!);
        assert.notEqual(await b.ready, oldPid);
        const resumed = value(
          await b.call<DropDiffPollResponse>({ action: "poll" }),
        );
        assert.deepEqual(
          resumed.events.map((event) => event.eventId),
          ["batch-note", "batch-done", "lost-ack-saved", "intervening-later"],
        );
        assert.deepEqual(
          resumed.events.map((event) => event.seq),
          [2, 3, 4, 5],
        );
        const latest = value(
          await b.call<DropDiffPollResponse>({
            action: "poll",
            cursor: "__latest__",
          }),
        );
        assert.deepEqual(latest.events, []);
        assert.equal(latest.cursor, "5");
        const excluded = value(
          await a.call<DropDiffPollResponse>({
            action: "poll",
            cursor: "-1",
            excludeClient: "client-A",
          }),
        );
        assert.deepEqual(
          excluded.events.map((event) => event.eventId),
          ["edit-second", "intervening-later"],
        );
        await content(b, fixture.final);
      },
    );
    await run(
      "native operations and optional predecessor retain public semantics",
      async () => {
        const branch = "native";
        await seed(branch, "x\n");
        // Frozen native payload is UTF-8 for 🙂; contradictory legacy text must not win.
        const event = applicationEvent("native-unicode", [
          {
            type: "insert",
            start: 0,
            end: 0,
            text: "WRONG",
            native: { op: 0, data: "8J+Zgg==", range: { start: 0, end: 0 } },
          },
        ]);
        await apply(a, event, branch);
        await content(b, "🙂x\n", branch);
        const polled = value(
          await b.call<DropDiffPollResponse>({
            action: "poll",
            branch,
            cursor: "-1",
          }),
        );
        assert.equal(polled.events[0].metadata?.followsSeq, undefined);
        assert.deepEqual(polled.events[0].ops, event.ops);
      },
    );
    await run(
      "native SQL later-event abort rolls back HTTP batch; exact retry commits one snapshot",
      async () => {
        const branch = "rollback";
        await seed(branch, "before\n");
        const events = [
          applicationEvent(
            "rollback-first",
            [{ type: "insert", start: 0, end: 0, text: "first\n" }],
            -1,
          ),
          applicationEvent(
            "rollback-second",
            [{ type: "insert", start: 13, end: 13, text: "second\n" }],
            0,
          ),
        ];
        const before = await inspect(branch);
        value(await runtime.call({ action: "arm-sql-fault", branch }));
        const offset = records.length;
        try {
          await rejected(
            a,
            { action: "batch", branch, events },
            503,
            "state_unavailable",
          );
          assert.deepEqual(records[offset].observers, []);
          assert.equal(records[offset].observerFailures, 0);
          assert.equal(records[offset].failureCode, "state_unavailable");
          assert.deepEqual(await inspect(branch), before);
          await content(b, "before\n", branch);
        } finally {
          value(await runtime.call({ action: "clear-sql-fault", branch }));
        }
        assert.equal(records[offset].calls["rpc.appendBatch"].errors, 1);
        const retried = await batch(a, events, branch);
        assert.equal(records[offset].bodyHash, records.at(-1)!.bodyHash);
        assert.deepEqual(
          retried.acknowledgements.map((ack) => [ack.seq, ack.snapshotId]),
          [
            [0, 1],
            [1, 1],
          ],
        );
        await content(b, "first\nbefore\nsecond\n", branch);
        const after = await inspect(branch);
        assert.deepEqual(after.counts, {
          branch_heads: 1,
          branch_snapshots: 2,
          branch_events: 2,
          branch_receipts: 2,
          branch_outbox: 1,
        });
      },
    );
    await run(
      "two-client races: fenced winner and unfenced contiguous acceptance",
      async () => {
        const branch = "race";
        await seed(branch, "");
        const make = (id: string, text: string, follows?: number) =>
          applicationEvent(
            id,
            [{ type: "insert", start: 0, end: 0, text }],
            follows,
            id.endsWith("B") ? "client-B" : "client-A",
          );
        const raced = await Promise.all([
          a.call<DropDiffAppendResponse>({
            action: "apply",
            branch,
            event: make("race-A", "A", -1),
          }),
          b.call<DropDiffAppendResponse>({
            action: "apply",
            branch,
            event: make("race-B", "B", -1),
          }),
        ]);
        assert.equal(raced.filter((entry) => entry.ok).length, 1);
        assert.equal(
          (raced.find((entry) => !entry.ok) as Failure).error.code,
          "diff_predecessor_mismatch",
        );
        const winner = raced[0].ok ? "A" : "B";
        await content(a, winner, branch);
        await Promise.all([
          apply(a, make("free-A", "a"), branch),
          apply(b, make("free-B", "b"), branch),
        ]);
        const final = value(
          await a.call<DropBranchContentResponse>({
            action: "content",
            branch,
          }),
        );
        assert.ok([`ab${winner}`, `ba${winner}`].includes(final.content));
        const inspection = await inspect(branch);
        assert.deepEqual(
          inspection.events.map((event) => event.event_seq),
          [0, 1, 2],
        );
        assert.equal(inspection.counts.branch_receipts, 3);
      },
    );
    await run(
      "unsupported capabilities fail closed and production Worker has no public HTTP surface",
      async () => {
        const before = await inspect();
        await rejected(
          a,
          { action: "request", path: diffPath() + "&cursor=-1&factCursor=-1" },
          501,
          "capability_unsupported",
        );
        await rejected(
          a,
          {
            action: "request",
            path: `/api/branches/${fixture.root}/${fixture.branch}/snapshots`,
          },
          501,
          "capability_unsupported",
        );
        await rejected(a, { action: "content", branch: "not-seeded" }, 404);
        assert.equal(
          value(
            await runtime.call<{ status: number }>({ action: "state-http" }),
          ).status,
          404,
        );
        assert.deepEqual(await inspect(), before);
      },
    );
    await run(
      "native runtime reset and OS restart preserve exact content, batch snapshots, receipts and outbox records",
      async () => {
        const before = await inspect();
        assert.equal(before.counts.branch_snapshots, 6);
        assert.equal(before.counts.branch_receipts, 6);
        assert.equal(
          before.counts.branch_outbox,
          5,
          "one outbox intent per accepted batch",
        );
        const reset = value(
          await runtime.call<{
            reset: boolean;
            generation: number;
            baseUrl: string;
            pid: number;
          }>({ action: "reset-runtime" }),
        );
        assert.equal(reset.reset, true);
        assert.equal(reset.generation, 1);
        assert.equal(reset.pid, pids[0]);
        upstream = reset.baseUrl;
        await content(a, fixture.final);
        assert.deepEqual(await inspect(), before);
        await runtime.close();
        runtime = new Peer("runtime");
        await startRuntime();
        assert.notEqual(pids[0], pids[1]);
        await content(a, fixture.final);
        await content(b, fixture.final);
        const replay = await batch(a, edits.batch);
        assert.deepEqual(
          replay.acknowledgements.map((ack) => [
            ack.seq,
            ack.snapshotId,
            ack.status,
          ]),
          [
            [2, 3, "duplicate"],
            [3, 3, "duplicate"],
          ],
        );
        assert.deepEqual(await inspect(), before);
        const polled = value(
          await b.call<DropDiffPollResponse>({ action: "poll", cursor: "3" }),
        );
        assert.deepEqual(
          polled.events.map((event) => event.eventId),
          ["lost-ack-saved", "intervening-later"],
        );
        writeFileSync(
          resolve(evidence, "application-durability.json"),
          JSON.stringify(
            {
              pids,
              runtimeReset: reset,
              individualObjectEviction: false,
              before,
              after: await inspect(),
            },
            null,
            2,
          ),
        );
      },
    );
    assert.deepEqual(
      drift(inputs),
      [],
      "CLI runtime sources match their pre-compilation pins",
    );
    await run(
      "real nd CLI reads the restarted application through authenticated HTTP",
      async () => {
        assert.equal(
          pids.length,
          2,
          "native runtime restarted before CLI read",
        );
        const child = spawn(
          "bun",
          [
            "--no-env-file",
            "run",
            "bin/nulldown.ts",
            "branch",
            "content",
            fixture.root,
            fixture.branch,
            `--base=${proxy.baseUrl}`,
            `--config-dir=${resolve(evidence, "cli-config")}`,
            "--timeout-ms=20000",
            "--json",
          ],
          {
            detached: true,
            cwd: root,
            env: {
              PATH: process.env.PATH,
              HOME: resolve(evidence, "empty-home"),
              TMPDIR: resolve(evidence, "temp"),
              CI: "true",
              ND_TOKEN: tokens[0],
              ND_CLIENT_ID: "acceptance-cli",
            },
            stdio: "pipe",
          },
        );
        const managed = trackChild(child);
        archiveStderr(child, "cli");
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout = (stdout + chunk.toString()).slice(0, 1000000);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(0, 1000000);
        });
        child.stdin.end();
        try {
          const { code } = await bounded(
            managed.exited,
            requestDeadlineMs,
            "CLI exit deadline",
          );
          assert.equal(code, 0, redact(stderr));
          const result = JSON.parse(stdout) as DropBranchContentResponse;
          assert.equal(result.content, fixture.final);
          assert.equal(result.branchId, fixture.branch);
          assert.ok(!stderr.includes(tokens[0]), "CLI does not leak bearer");
        } finally {
          await terminate(managed, "CLI complete or timed out");
        }
      },
    );
    assert.deepEqual(
      drift(inputs),
      [],
      "CLI runtime sources remained pinned through execution",
    );
    await run(
      "whole-request dependency budgets include auth, RPC errors and drained observers",
      async () => {
        assert.ok(records.length > 30);
        assert.equal(
          new Set(records.map((record) => record.requestId)).size,
          records.length,
        );
        for (const record of records) {
          assert.equal(
            Object.entries(record.calls)
              .filter(([name]) => name.startsWith("r2."))
              .reduce((total, [, row]) => total + row.count, 0),
            0,
            JSON.stringify(record),
          );
          assert.equal(record.sqlWrites, 0);
          assert.equal(
            record.background.scheduled,
            record.background.completed + record.background.failed,
          );
          assert.equal(record.background.failed, 0);
          assert.ok(record.totalMs >= record.handlerMs);
        }
        assert.ok(
          records.some((record) => record.sqlReads > 0),
          "real authorization D1 reads measured",
        );
        assert.ok(
          records.some((record) => record.calls["rpc.appendBatch"]?.errors > 0),
          "RPC failure counts measured",
        );
        assert.ok(
          records.some(
            (record) => record.observerFailures === 1 && record.status === 200,
          ),
          "observer failure isolated from committed response",
        );
      },
    );
    assert.equal(
      checks.filter((check) => check.workload === "baseline").length,
      13,
    );
    workload = "lifecycle";
    await run(
      "SDK sealed root creation produces real ownership projections without branch seeds",
      async () => {
        const setup = value(
          await runtime.call({
            action: "setup-authoring",
            account: {
              accountId: lifecycle.owner,
              signingPublicJwk: authoring.signingPublicJwk,
              encryptionPublicJwk: authoring.encryptionPublicJwk,
            },
          }),
        );
        writeFileSync(
          resolve(evidence, "application-authoring-setup.json"),
          JSON.stringify(
            {
              scope:
                "synthetic account public keys and signed sessions; no login or refresh",
              setup,
              publicKeyHashes: {
                signing: sha256(JSON.stringify(authoring.signingPublicJwk)),
                encryption: sha256(
                  JSON.stringify(authoring.encryptionPublicJwk),
                ),
                provider: sha256(JSON.stringify(authoring.providerPublicJwk)),
              },
            },
            null,
            2,
          ),
        );
        await configure(a, tokens[3], "lifecycle-A", undefined, authoring);
        for (const rootId of applicationLifecycleRoots) {
          const initial =
            rootId === lifecycle.privateRoot
              ? lifecycle.privateInitial
              : lifecycle.initial;
          const visibility =
            rootId === lifecycle.privateRoot ? "private" : "unlisted";
          const before = value(
            await runtime.call<RootInspection>({
              action: "inspect-root",
              rootId,
            }),
          );
          assert.equal(before.exists, false);
          assert.equal(before.projection, null);
          assert.equal(before.legacyBranches, 0);
          const offset = records.length;
          const created = value(
            await a.call<{ id: string }>({
              action: "create-root",
              visibility,
              create: {
                id: rootId,
                content: initial,
                metadata: { themeId: "system" },
              },
            }),
          );
          assert.equal(created.id, rootId);
          const request = records[offset];
          assert.equal(request.phase, "root-create");
          assert.ok(request.calls["r2.put"]?.count > 0);
          assert.ok(request.sqlWrites > 0);
          assert.equal(request.calls["rpc.appendBatch"], undefined);
          const after = value(
            await runtime.call<RootInspection>({
              action: "inspect-root",
              rootId,
              content: initial,
            }),
          );
          assert.equal(after.exists, true);
          assert.equal(after.sealed, true);
          assert.equal(after.containsPlaintext, false);
          assert.deepEqual(after.unexpectedFields, []);
          assert.equal(after.accountId, lifecycle.owner);
          assert.equal(after.visibility, visibility);
          assert.deepEqual(after.projection, {
            account_id: lifecycle.owner,
            visibility,
            deleted_at: null,
          });
          assert.equal(after.legacyBranches, 0);
          assert.ok(after.revision);
          const read = value(
            await a.call<{ id: string; revision: string; text: string }>({
              action: "root",
              rootId,
            }),
          );
          assert.equal(read.id, rootId);
          assert.equal(read.revision.replaceAll('"', ""), after.revision);
          const stored = JSON.parse(read.text) as Record<string, unknown>;
          for (const probe of [
            { ...stored, content: initial },
            { ...stored, metadata: { debug: { plaintext: initial } } },
          ]) {
            const raw = JSON.stringify(probe);
            assert.equal(
              raw.includes(initial),
              false,
              "multiline plaintext is JSON escaped",
            );
            assert.ok(
              raw.includes(JSON.stringify(initial).slice(1, -1)),
              "escaped plaintext sentinel is present",
            );
            const inspection = inspectApplicationRootStorage(raw, initial);
            assert.equal(
              inspection.sealed,
              true,
              "adversarial extra fields do not invalidate permissive envelope decoding",
            );
            assert.equal(
              inspection.containsPlaintext,
              true,
              "top-level and nested plaintext must be detected",
            );
            assert.ok(inspection.unexpectedFields.length > 0);
          }
        }
        for (const jwk of [authoring.signingPrivateJwk, providerPrivateJwk]) {
          const redacted = redact(JSON.stringify(jwk));
          for (const key of ["d", "p", "q", "dp", "dq", "qi"] as const)
            if (jwk[key]) assert.ok(!redacted.includes(jwk[key]!));
        }
        await assertRootWritesRejected(lifecycle.root);
      },
    );
    await run(
      "real private root rejects missing, forged and outsider branch resolution",
      async () => {
        const rootId = lifecycle.privateRoot;
        const before = value(
          await runtime.call<RootInspection>({
            action: "inspect-root",
            rootId,
          }),
        );
        for (const [authorization, status] of [
          ["", 401],
          ["Bearer invalid", 401],
          [`Bearer ${tokens[4]}`, 404],
        ] as const) {
          const offset = records.length;
          await rejected(
            a,
            {
              action: "request",
              method: "POST",
              path: `/api/branches/resolve/${rootId}`,
              headers: {
                Authorization: authorization,
                "x-nulldown-account-id": lifecycle.owner,
              },
            },
            status,
          );
          assert.equal(records[offset].phase, "bootstrap");
          assert.equal(
            Object.keys(records[offset].calls).some((name) =>
              name.startsWith("rpc."),
            ),
            false,
          );
          assert.equal(records[offset].sqlWrites, 0);
        }
        assert.deepEqual(
          value(
            await runtime.call<RootInspection>({
              action: "inspect-root",
              rootId,
            }),
          ),
          before,
        );
      },
    );
    await run(
      "normal owner resolution, two-client edits and exact ascending snapshot history",
      async () => {
        await configure(b, tokens[3], "lifecycle-B");
        const rootId = lifecycle.root;
        const resolved = await resolveBranch(a, rootId);
        assert.equal(resolved.branchId, "owner");
        assert.equal(resolved.created, true);
        assert.equal(resolved.ownerAccountId, lifecycle.owner);
        assert.equal(resolved.writerAccountId, lifecycle.owner);
        const zero = await lifecycleContent(a, rootId, "owner", 0);
        assert.equal(zero.content, lifecycle.initial);
        assert.equal(zero.snapshotId, 0);
        assert.equal(zero.headEventSeq, -1);
        const initialized = await inspect("owner", rootId);
        assert.equal(initialized.authority?.state, "active");
        assert.deepEqual(initialized.counts, {
          branch_heads: 1,
          branch_snapshots: 1,
          branch_events: 0,
          branch_receipts: 0,
          branch_outbox: 0,
        });
        const one = applicationEvent(
          "lifecycle-first",
          [
            {
              type: "insert",
              start: lifecycle.initial.length,
              end: lifecycle.initial.length,
              text: "first\n",
            },
          ],
          -1,
          "lifecycle-A",
          rootId,
        );
        const two = applicationEvent(
          "lifecycle-second",
          [
            {
              type: "insert",
              start: lifecycle.first.length,
              end: lifecycle.first.length,
              text: "second\n",
            },
          ],
          0,
          "lifecycle-B",
          rootId,
        );
        const first = await apply(a, one, "owner");
        assert.deepEqual(
          first.acknowledgements.map((ack) => [ack.seq, ack.snapshotId]),
          [[0, 1]],
        );
        assert.equal(
          (await lifecycleContent(b, rootId)).content,
          lifecycle.first,
        );
        await apply(b, two, "owner");
        assert.equal(
          (await lifecycleContent(a, rootId)).content,
          lifecycle.second,
        );
        for (const [snapshotId, expected] of [
          lifecycle.initial,
          lifecycle.first,
          lifecycle.second,
        ].entries()) {
          const read = await lifecycleContent(b, rootId, "owner", snapshotId);
          assert.equal(read.snapshotId, snapshotId);
          assert.equal(read.content, expected);
          assert.equal(read.headEventSeq, snapshotId - 1);
        }
        const history = await lifecycleHistory(a, rootId);
        assert.deepEqual(
          history.snapshots.map((snapshot) => snapshot.snapshotId),
          [0, 1, 2],
        );
        assert.deepEqual(
          history.snapshots.map((snapshot) => snapshot.parentSnapshotId),
          [null, 0, 1],
        );
        assert.deepEqual(
          history.snapshots.map((snapshot) => snapshot.eventIds),
          [[], [one.eventId], [two.eventId]],
        );
        await rejected(
          a,
          { action: "content", rootId, branch: "owner", snapshotId: 999 },
          404,
          "http_error",
        );
        const third = applicationEvent(
          "lifecycle-captured-head",
          [
            {
              type: "insert",
              start: lifecycle.second.length,
              end: lifecycle.second.length,
              text: "third\n",
            },
          ],
          1,
          "lifecycle-B",
          rootId,
        );
        await armFault(rootId, "readHead", "pause", "after");
        const capturedRead = lifecycleContent(a, rootId);
        let barrier: { requestId: string; snapshotId: number };
        try {
          barrier = value(await runtime.call({ action: "wait-rpc-fault" }));
          assert.equal(
            barrier.snapshotId,
            2,
            "content request captured the old head before the interleaved append",
          );
          const appended = await apply(b, third, "owner");
          assert.equal(
            appended.snapshotId,
            3,
            "new head committed while the old-head response was paused",
          );
        } finally {
          value(await runtime.call({ action: "release-rpc-fault" }));
        }
        const captured = await capturedRead;
        assert.equal(captured.snapshotId, 2);
        assert.equal(captured.content, lifecycle.second);
        assert.equal(captured.headEventSeq, 1);
        assert.equal((await lifecycleContent(b, rootId)).snapshotId, 3);
        let expected = lifecycle.second + "third\n";
        const historyStart = performance.now();
        for (
          let snapshotId = 4;
          snapshotId <= lifecycle.historyLastSnapshot;
          snapshotId++
        ) {
          const peer = snapshotId % 2 ? a : b;
          const event = applicationEvent(
            `lifecycle-history-${snapshotId}`,
            [
              {
                type: "insert",
                start: expected.length,
                end: expected.length,
                text: lifecycle.historyLine,
              },
            ],
            snapshotId - 2,
            snapshotId % 2 ? "lifecycle-A" : "lifecycle-B",
            rootId,
          );
          const receipt = await apply(peer, event, "owner");
          assert.equal(receipt.accepted, 1);
          assert.equal(receipt.snapshotId, snapshotId);
          assert.equal(receipt.acknowledgements[0].seq, snapshotId - 1);
          expected += lifecycle.historyLine;
        }
        assert.equal(expected, lifecycle.historyFinal);
        const historyOffset = records.length;
        const complete = await lifecycleHistory(a, rootId);
        assert.deepEqual(
          complete.snapshots.map((snapshot) => snapshot.snapshotId),
          Array.from(
            { length: lifecycle.historyLastSnapshot + 1 },
            (_, id) => id,
          ),
        );
        assert.equal(
          records[historyOffset].calls["rpc.listSnapshots"].count,
          2,
          "public history drained two real bounded backend pages",
        );
        for (const id of [199, 200, 201]) {
          const historical = await lifecycleContent(b, rootId, "owner", id);
          const text =
            lifecycle.second + "third\n" + lifecycle.historyLine.repeat(id - 3);
          assert.equal(historical.snapshotId, id);
          assert.equal(historical.headEventSeq, id - 1);
          assert.equal(historical.content, text);
          assert.equal(
            complete.snapshots[id].sourceContentHash,
            `sha256:${createHash("sha256").update(`nulldown.source-content.v1\n${text}`).digest("base64url")}`,
          );
        }
        writeFileSync(
          resolve(evidence, "application-history.json"),
          JSON.stringify(
            {
              separateAcceptedAppends: lifecycle.historyLastSnapshot,
              snapshots: complete.snapshots.length,
              backendPages:
                records[historyOffset].calls["rpc.listSnapshots"].count,
              extendedHistoryMs: performance.now() - historyStart,
              capturedHeadBarrier: barrier!,
              capturedSnapshotId: captured.snapshotId,
              interleavedSnapshotId: 3,
              contentHash: sha256(expected),
            },
            null,
            2,
          ),
        );
        assert.equal(
          (await lifecycleContent(a, rootId, "owner", 0)).content,
          lifecycle.initial,
        );
        await assertRootWritesRejected(rootId);
      },
    );
    await run(
      "concurrent actor resolution converges while distinct accounts receive distinct clones",
      async () => {
        const rootId = lifecycle.concurrentRoot;
        const resolved = await Promise.all([
          resolveBranch(a, rootId),
          resolveBranch(b, rootId),
        ]);
        assert.deepEqual(
          resolved.map((result) => result.branchId),
          ["owner", "owner"],
        );
        assert.equal(resolved.filter((result) => result.created).length, 1);
        const state = await inspect("owner", rootId);
        assert.equal(state.counts.branch_snapshots, 1);
        assert.equal(state.counts.branch_events, 0);
        assert.equal(
          state.authority?.reservation.identity.ownerAccountId,
          lifecycle.owner,
        );
        await Promise.all([
          configure(a, tokens[4], "clone-client-A"),
          configure(b, tokens[4], "clone-client-B"),
        ]);
        const clones = await Promise.all([
          resolveBranch(a, rootId),
          resolveBranch(b, rootId),
        ]);
        const clone = clones[0];
        assert.equal(clones[1].branchId, clone.branchId);
        assert.equal(clones.filter((result) => result.created).length, 1);
        assert.equal(clone.branchId, `clone_account:${lifecycle.writer}`);
        assert.equal(clone.mode, "clone");
        assert.equal(clone.writerAccountId, lifecycle.writer);
        assert.equal((await resolveBranch(b, rootId)).created, false);
        assert.equal(
          (await lifecycleContent(b, rootId, clone.branchId, 0)).content,
          lifecycle.initial,
        );
        assert.equal(
          (await lifecycleHistory(b, rootId, clone.branchId)).snapshots.length,
          1,
        );
        const sameAccount = await inspect(clone.branchId, rootId);
        assert.equal(sameAccount.counts.branch_snapshots, 1);
        assert.equal(
          sameAccount.authority?.reservation.identity.writerAccountId,
          lifecycle.writer,
        );
        await configure(b, tokens[5], "other-clone-client");
        const otherClone = await resolveBranch(b, rootId);
        assert.equal(
          otherClone.branchId,
          `clone_account:${lifecycle.otherWriter}`,
        );
        assert.notEqual(otherClone.branchId, clone.branchId);
        assert.equal(otherClone.writerAccountId, lifecycle.otherWriter);
        assert.equal(
          (await lifecycleContent(b, rootId, otherClone.branchId, 0)).content,
          lifecycle.initial,
        );
        assert.equal(
          (await inspect(otherClone.branchId, rootId)).counts.branch_snapshots,
          1,
        );
        assert.deepEqual(await inspect(clone.branchId, rootId), sameAccount);
        await Promise.all([
          configure(a, tokens[3], "lifecycle-A", undefined, authoring),
          configure(b, tokens[3], "lifecycle-B"),
        ]);
        assert.deepEqual(await inspect("owner", rootId), state);
      },
    );
    await run(
      "reservation and initialization lost acknowledgements recover without root replacement",
      async () => {
        const rootId = lifecycle.lostRoot;
        await armFault(rootId, "reserve");
        await rejected(
          a,
          { action: "resolve", rootId },
          503,
          "state_unavailable",
        );
        const pending = await inspect("owner", rootId);
        assert.equal(pending.authority?.state, "pending");
        assert.equal(pending.counts.branch_heads, 0);
        assert.equal(pending.counts.branch_snapshots, 0);
        await assertRootWritesRejected(rootId);
        await armFault(rootId, "initialize");
        await rejected(
          a,
          { action: "resolve", rootId },
          503,
          "state_unavailable",
        );
        const active = await inspect("owner", rootId);
        assert.equal(active.authority?.state, "active");
        assert.deepEqual(
          active.authority?.reservation,
          pending.authority?.reservation,
        );
        assert.equal(active.counts.branch_snapshots, 1);
        assert.equal((await resolveBranch(a, rootId)).created, false);
        assert.deepEqual(await inspect("owner", rootId), active);
        await assertRootWritesRejected(rootId);
        const dropped = await a.call({
          action: "resolve",
          rootId: lifecycle.privateRoot,
          loseAck: true,
        });
        assert.equal(dropped.ok, false);
        const receipt = proxy.lostResponse() as DropBranchResolveResponse;
        assert.equal(receipt.rootDropId, lifecycle.privateRoot);
        assert.equal(receipt.created, true);
        const retried = await resolveBranch(a, lifecycle.privateRoot);
        assert.equal(retried.branchId, receipt.branchId);
        assert.equal(retried.created, false);
        assert.equal(
          (await lifecycleContent(a, lifecycle.privateRoot, "owner", 0))
            .content,
          lifecycle.privateInitial,
        );
        const before = await inspect("owner", lifecycle.privateRoot);
        await configure(b, tokens[4], "lifecycle-outsider");
        const forbidden = applicationEvent(
          "private-outsider",
          [{ type: "insert", start: 0, end: 0, text: "BAD" }],
          -1,
          "lifecycle-outsider",
          lifecycle.privateRoot,
        );
        await rejected(
          b,
          { action: "apply", branch: "owner", event: forbidden },
          403,
          "branch_write_forbidden",
        );
        await rejected(
          b,
          {
            action: "request",
            path: `/api/diff/${lifecycle.privateRoot}`,
            method: "POST",
            events: [forbidden],
            headers: { "Content-Type": "application/json" },
          },
          404,
        );
        await rejected(
          b,
          {
            action: "content",
            rootId: lifecycle.privateRoot,
            branch: "owner",
            snapshotId: 0,
          },
          404,
        );
        assert.deepEqual(await inspect("owner", lifecycle.privateRoot), before);
        await configure(b, tokens[3], "lifecycle-B");
      },
    );
    await run(
      "pending initialization survives process interruption and exact edit retry survives lost response",
      async () => {
        const rootId = lifecycle.crashRoot;
        await armFault(rootId, "reserve", "hold");
        const interrupted = a.call({ action: "resolve", rootId });
        value(await runtime.call({ action: "wait-rpc-fault" }));
        const pending = await inspect("owner", rootId);
        assert.equal(pending.authority?.state, "pending");
        assert.equal(pending.counts.branch_snapshots, 0);
        const count = value(
          await runtime.call<{ outbound: number }>({
            action: "outbound-count",
          }),
        );
        assert.equal(count.outbound, 0);
        const pid = await runtime.ready;
        const offset = proxy.interrupted.length;
        await runtime.forceStop(
          "crash after durable reservation before initialization",
        );
        assert.equal((await interrupted).ok, false);
        assert.equal(proxy.interrupted.length, offset + 1);
        runtime = new Peer("runtime");
        await startRuntime();
        const recoveredPid = await runtime.ready;
        assert.notEqual(recoveredPid, pid);
        const recovered = await resolveBranch(a, rootId);
        assert.equal(recovered.branchId, "owner");
        const active = await inspect("owner", rootId);
        assert.deepEqual(
          active.authority?.reservation,
          pending.authority?.reservation,
        );
        assert.equal(active.counts.branch_snapshots, 1);
        const event = applicationEvent(
          "lifecycle-crash-retry",
          [
            {
              type: "insert",
              start: lifecycle.initial.length,
              end: lifecycle.initial.length,
              text: "first\n",
            },
          ],
          -1,
          "lifecycle-A",
          rootId,
        );
        assert.equal(
          (
            await a.call({
              action: "apply",
              branch: "owner",
              event,
              loseAck: true,
            })
          ).ok,
          false,
        );
        const committed = proxy.lostReceipt()!;
        const before = await inspect("owner", rootId);
        await runtime.close();
        runtime = new Peer("runtime");
        await startRuntime();
        const retried = await apply(a, event, "owner");
        assert.equal(retried.accepted, 0);
        assert.deepEqual(
          retried.acknowledgements,
          committed.acknowledgements.map((ack) => ({
            ...ack,
            status: "duplicate",
          })),
        );
        assert.deepEqual(await inspect("owner", rootId), before);
        assert.equal(
          (await lifecycleContent(b, rootId)).content,
          lifecycle.first,
        );
        writeFileSync(
          resolve(evidence, "application-initialization-crash.json"),
          JSON.stringify(
            {
              pid,
              recoveredPid,
              editRetryPid: await runtime.ready,
              pending,
              active,
              outboundBeforeCrash: count.outbound,
              interrupted: proxy.interrupted,
              boundary: "after durable reservation; before initialize",
              individualObjectEviction: false,
            },
            null,
            2,
          ),
        );
      },
    );
    await run(
      "unseeded lifecycle placement and history survive runtime reset and OS restart",
      async () => {
        const rootId = lifecycle.root;
        const before = await inspect("owner", rootId);
        const history = await lifecycleHistory(a, rootId);
        const reset = value(
          await runtime.call<{ baseUrl: string }>({ action: "reset-runtime" }),
        );
        upstream = reset.baseUrl;
        assert.deepEqual(await inspect("owner", rootId), before);
        assert.deepEqual(await lifecycleHistory(a, rootId), history);
        assert.equal(
          (await lifecycleContent(b, rootId, "owner", 0)).content,
          lifecycle.initial,
        );
        const oldPid = await runtime.ready;
        await runtime.close();
        runtime = new Peer("runtime");
        await startRuntime();
        assert.notEqual(await runtime.ready, oldPid);
        assert.equal((await resolveBranch(a, rootId)).created, false);
        assert.deepEqual(await inspect("owner", rootId), before);
        assert.deepEqual(await lifecycleHistory(b, rootId), history);
        assert.equal(
          (await lifecycleContent(a, rootId)).content,
          lifecycle.historyFinal,
        );
      },
    );
    await run(
      "legacy composition remains legacy and selected authority failures never fall back",
      async () => {
        const rootId = lifecycle.legacyRoot;
        await configure(
          b,
          tokens[3],
          "legacy-client",
          undefined,
          undefined,
          "/__legacy",
        );
        assert.equal((await resolveBranch(b, rootId)).branchId, "owner");
        const before = await inspectRoot(rootId);
        assert.ok(before.legacyBranches > 0);
        assert.equal(
          (await lifecycleContent(b, rootId)).content,
          lifecycle.initial,
        );
        await rejected(
          a,
          { action: "resolve", rootId },
          409,
          "branch_authority_mismatch",
        );
        assert.deepEqual(await inspectRoot(rootId), before);
        assert.equal((await resolveBranch(b, rootId)).created, false);
        assert.equal(
          (await lifecycleContent(b, rootId)).content,
          lifecycle.initial,
        );
        await configure(b, tokens[3], "lifecycle-B");
        const state = await inspect("owner", lifecycle.root);
        assert.equal(state.authority?.state, "active");
        await armFault(lifecycle.root, "readPlacement");
        const offset = records.length;
        await rejected(
          a,
          { action: "content", rootId: lifecycle.root, branch: "owner" },
          503,
          "state_unavailable",
        );
        assert.equal(records[offset].calls["rpc.readPlacement"].errors, 1);
        assert.equal(
          Object.keys(records[offset].calls).some((name) =>
            name.startsWith("r2."),
          ),
          false,
        );
        assert.equal(records[offset].sqlWrites, 0);
        assert.deepEqual(await inspect("owner", lifecycle.root), state);
        await armFault(lifecycle.root, "readHead", "stale-generation");
        await rejected(
          a,
          { action: "content", rootId: lifecycle.root, branch: "owner" },
          409,
          "routing_generation_mismatch",
        );
        assert.equal(records.at(-1)!.calls["rpc.readHead"].errors, 1);
        assert.deepEqual(await inspect("owner", lifecycle.root), state);
        for (const record of records.filter(
          (row) => row.phase === "steady-state",
        )) {
          assert.equal(
            Object.keys(record.calls).some((name) => name.startsWith("r2.")),
            false,
            record.requestId,
          );
          assert.equal(record.sqlWrites, 0, record.requestId);
        }
        for (const record of records) {
          assert.equal(
            record.background.scheduled,
            record.background.completed + record.background.failed,
          );
          assert.equal(record.background.failed, 0);
        }
      },
    );
    workload = "runtime-facts";
    const runtimeRequestOffset = records.length;
    const factMarker = `sensitive-runtime-${randomBytes(24).toString("hex")}`;
    sensitiveValues.add(factMarker);
    const sourceHash = (text: string) =>
      `sha256:${createHash("sha256").update(`nulldown.source-content.v1\n${text}`).digest("base64url")}`;
    const makePatch = (
      id: string,
      rootId: string = runtimeFacts.root,
      text: string = runtimeFacts.initial,
      callId = "runtime-call",
    ): NullplugUiStatePatchFact => ({
      version: 1,
      kind: "ui.state.patch",
      id,
      callId,
      createdAt: 123,
      source: {
        rootDropId: rootId,
        branchId: "owner",
        snapshotId: 999,
        sourceContentHash: sourceHash(text),
        callId,
      },
      patch: [{ op: "set", path: ["privateValue"], value: factMarker }],
      metadata: { actorAccountId: "must-be-overridden" },
    });
    const factCommand = (
      fact: NullplugUiRuntimeFact,
      loseAck = false,
    ): Command =>
      fact.kind === "ui.response"
        ? { action: "submit-response", responseFact: fact, loseAck }
        : { action: "store-state", stateFact: fact, loseAck };
    const submitFact = async (peer: Peer, fact: NullplugUiRuntimeFact) =>
      value(await peer.call<FactSubmission>(factCommand(fact)));
    const pollFacts = async (
      peer: Peer,
      rootId: string = runtimeFacts.root,
      branch = "owner",
      after = "-1",
      factLimit = 200,
    ) => {
      const response = value(
        await peer.call<DropDiffPollResponse>({
          action: "poll",
          rootId,
          branch,
          cursor: "-1",
          factCursor: after,
          factLimit,
        }),
      );
      assert.ok(Array.isArray(response.facts));
      for (const event of response.facts)
        assert.ok(isDropBranchRuntimeFact(event));
      return response;
    };
    const assertSubmission = (
      result: FactSubmission,
      requested: NullplugUiRuntimeFact,
      snapshotId: number,
      duplicate = false,
      actor = lifecycle.owner as string,
    ) => {
      assert.equal(result.stored, true);
      assert.equal(result.indexed, false);
      assert.equal(result.duplicate, duplicate);
      assert.equal(result.runtimeFact.appended, !duplicate);
      assert.ok(isDropBranchRuntimeFact(result.runtimeFact.event));
      assert.equal(
        result.runtimeFact.event.factId,
        nullplugUiRuntimeFactId(requested),
      );
      assert.deepEqual(result.runtimeFact.event.fact, result.fact);
      assert.equal(result.fact.metadata?.actorAccountId, actor);
      assert.equal(result.fact.source.snapshotId, snapshotId);
      assert.equal(
        result.fact.source.sourceContentHash,
        requested.source.sourceContentHash,
      );
      assert.ok(result.fact.createdAt > requested.createdAt);
      assert.equal(
        result.key,
        requested.kind === "ui.response"
          ? nullplugUiResponseFactKey(requested)
          : requested.kind === "ui.state.patch"
            ? nullplugUiStatePatchFactKey(requested)
            : nullplugUiStateSnapshotKey(requested),
      );
      assert.deepEqual(result.fact, {
        ...requested,
        createdAt: result.fact.createdAt,
        source: { ...requested.source, snapshotId },
        metadata: { ...requested.metadata, actorAccountId: actor },
      });
    };
    const inspectRuntimeFacts = async (
      rootId: string = runtimeFacts.root,
      branch = "owner",
    ) =>
      value(
        await runtime.call<RuntimeFactInspection>({
          action: "inspect-runtime-facts",
          rootId,
          branch,
        }),
      );
    const factState = async (rootId: string = runtimeFacts.root) => ({
      branch: await inspect("owner", rootId),
      runtime: await inspectRuntimeFacts(rootId),
      content: await lifecycleContent(a, rootId),
      poll: await pollFacts(a, rootId),
    });
    const appendRuntimeEdit = async (eventId: string, line: string) => {
      const before = await lifecycleContent(a, runtimeFacts.root);
      const branch = await inspect("owner", runtimeFacts.root);
      const event = applicationEvent(
        eventId,
        [
          {
            type: "insert",
            start: before.content.length,
            end: before.content.length,
            text: line,
          },
        ],
        branch.events.at(-1)?.event_seq ?? -1,
        "runtime-B",
        runtimeFacts.root,
      );
      const result = value(
        await b.call<DropDiffAppendResponse>({
          action: "apply",
          branch: "owner",
          event,
        }),
      );
      assert.equal(result.accepted, 1);
      assert.equal(
        (await lifecycleContent(a, runtimeFacts.root)).content,
        before.content + line,
      );
      return before.content + line;
    };
    const originalFacts: {
      requested: NullplugUiRuntimeFact;
      response: FactSubmission;
    }[] = [];
    const runtimeTargets = applicationRuntimeRoots.map((rootId) => ({
      rootId,
      branch: "owner",
    }));
    await run(
      "runtime facts use isolated signed SDK roots and normal branch initialization",
      async () => {
        await configure(a, tokens[3], "runtime-A", undefined, authoring);
        await configure(b, tokens[3], "runtime-B");
        for (const rootId of applicationRuntimeRoots) {
          const privateRoot = rootId === runtimeFacts.privateRoot;
          const initial = privateRoot
            ? runtimeFacts.privateInitial
            : runtimeFacts.initial;
          const visibility = privateRoot ? "private" : "unlisted";
          const before = await inspectRoot(rootId);
          assert.equal(before.exists, false);
          assert.equal(before.projection, null);
          assert.equal(before.legacyBranches, 0);
          const created = value(
            await a.call<{ id: string }>({
              action: "create-root",
              visibility,
              create: {
                id: rootId,
                content: initial,
                metadata: { themeId: "system" },
              },
            }),
          );
          assert.equal(created.id, rootId);
          const stored = value(
            await runtime.call<RootInspection>({
              action: "inspect-root",
              rootId,
              content: initial,
            }),
          );
          assert.equal(stored.sealed, true);
          assert.equal(stored.containsPlaintext, false);
          assert.deepEqual(stored.unexpectedFields, []);
          assert.deepEqual(stored.projection, {
            account_id: lifecycle.owner,
            visibility,
            deleted_at: null,
          });
          const initialized = await resolveBranch(a, rootId);
          assert.equal(initialized.branchId, "owner");
          assert.equal(initialized.created, true);
          const sameAccount = await resolveBranch(b, rootId);
          assert.equal(sameAccount.branchId, initialized.branchId);
          assert.equal(sameAccount.created, false);
          const offset = records.length;
          assert.equal((await lifecycleContent(b, rootId)).content, initial);
          assert.equal(records[offset].phase, "runtime-facts");
          assert.equal(records[offset].sqlWrites, 0);
          assert.equal(
            Object.keys(records[offset].calls).some((name) =>
              name.startsWith("r2."),
            ),
            false,
          );
          const initializedState = await inspect("owner", rootId);
          assert.equal(initializedState.authority?.state, "active");
          assert.equal(initializedState.counts.branch_snapshots, 1);
          assert.equal(initializedState.counts.branch_events, 0);
          assert.equal(initializedState.counts.branch_outbox, 0);
          assert.equal((await inspectRoot(rootId)).legacyBranches, 0);
        }
        const patch = makePatch("first-patch");
        const snapshot: NullplugUiStateSnapshot = {
          version: 1,
          kind: "ui.state.snapshot",
          id: "first-snapshot",
          callId: patch.callId,
          createdAt: 123,
          source: { ...patch.source },
          state: { privateValue: factMarker },
          patchIds: [patch.id],
        };
        const response: NullplugUiResponseFact = {
          version: 1,
          kind: "ui.response",
          id: "first-response",
          primitiveId: "approval",
          createdAt: 123,
          source: { ...patch.source },
          data: { privateValue: factMarker },
          proposedDiffs: {
            version: 1,
            events: [
              applicationEvent(
                "unapproved-proposal",
                [
                  {
                    type: "insert",
                    start: 0,
                    end: 0,
                    text: "must not execute\n",
                  },
                ],
                -1,
                "runtime-A",
                runtimeFacts.root,
              ),
            ],
          },
        };
        const before = await inspect("owner", runtimeFacts.root);
        for (const requested of [patch, snapshot, response]) {
          const stored = await submitFact(a, requested);
          assertSubmission(stored, requested, 0);
          originalFacts.push({ requested, response: stored });
        }
        const polled = await pollFacts(b);
        assert.deepEqual(
          polled.facts,
          originalFacts.map((entry) => entry.response.runtimeFact.event),
        );
        assert.deepEqual(
          polled.facts!.map((event) => event.seq),
          [0, 1, 2],
        );
        assert.equal(polled.factCursor, "2");
        assert.deepEqual(polled.events, []);
        assert.equal(
          (await lifecycleContent(a, runtimeFacts.root)).content,
          runtimeFacts.initial,
        );
        const after = await inspect("owner", runtimeFacts.root);
        assert.deepEqual(after.events, before.events);
        assert.equal(
          after.counts.branch_snapshots,
          before.counts.branch_snapshots,
        );
        const privatePatch = makePatch(
          "private-patch",
          runtimeFacts.privateRoot,
          runtimeFacts.privateInitial,
        );
        assertSubmission(await submitFact(a, privatePatch), privatePatch, 0);
        assert.equal(
          (await pollFacts(b, runtimeFacts.privateRoot)).facts!.length,
          1,
        );
        const empty = await pollFacts(a, runtimeFacts.pageRoot);
        assert.deepEqual(empty.facts, []);
        assert.deepEqual(empty.events, []);
      },
    );
    await run(
      "runtime fact concurrency preserves one receipt per identity and scoped immutable data",
      async () => {
        const same = makePatch("concurrent-same");
        const results = await Promise.all([
          submitFact(a, same),
          submitFact(b, same),
        ]);
        assert.deepEqual(results.map((result) => result.duplicate).sort(), [
          false,
          true,
        ]);
        for (const result of results)
          assertSubmission(result, same, 0, result.duplicate);
        assert.deepEqual(results[0].fact, results[1].fact);
        assert.deepEqual(
          results[0].runtimeFact.event,
          results[1].runtimeFact.event,
        );
        const distinct = [
          makePatch("same-id", undefined, undefined, "call-A"),
          makePatch("same-id", undefined, undefined, "call-B"),
        ];
        const distinctResults = await Promise.all(
          distinct.map((fact, index) => submitFact(index ? b : a, fact)),
        );
        distinctResults.forEach((result, index) =>
          assertSubmission(result, distinct[index], 0),
        );
        assert.notEqual(
          distinctResults[0].runtimeFact.event.factId,
          distinctResults[1].runtimeFact.event.factId,
        );
        const alias = makePatch("tail", undefined, undefined, "alias:part");
        assertSubmission(await submitFact(a, alias), alias, 0);
        await rejected(
          b,
          factCommand(makePatch("part:tail", undefined, undefined, "alias")),
          409,
          "idempotency_key_reused",
        );
        const polled = await pollFacts(a);
        assert.deepEqual(
          polled.facts!.map((event) => event.seq),
          Array.from({ length: 7 }, (_, index) => index),
        );
        assert.equal(
          new Set(polled.facts!.map((event) => event.factId)).size,
          7,
        );
        assert.equal(
          (await lifecycleContent(a, runtimeFacts.root)).content,
          runtimeFacts.initial,
        );
      },
    );
    await run(
      "runtime state and response lost acknowledgements replay original facts after intervening edits",
      async () => {
        for (const kind of ["state", "response"] as const) {
          const head = await lifecycleContent(a, runtimeFacts.root);
          const requested: NullplugUiRuntimeFact =
            kind === "state"
              ? makePatch("lost-state", runtimeFacts.root, head.content)
              : {
                  version: 1,
                  kind: "ui.response",
                  id: "lost-response",
                  primitiveId: "approval",
                  createdAt: 123,
                  source: makePatch("source", runtimeFacts.root, head.content)
                    .source,
                  data: { privateValue: factMarker },
                };
          const offset = records.length;
          const failed = await a.call(factCommand(requested, true));
          assert.equal(
            failed.ok,
            false,
            "real relay drops only a completed successful response",
          );
          const lost = proxy.lostResponse() as FactSubmission;
          assertSubmission(lost, requested, head.snapshotId);
          assert.equal(records[offset].lostAck, true);
          await appendRuntimeEdit(`after-lost-${kind}`, `after ${kind}\n`);
          const beforeRetry = await factState();
          const retried = await submitFact(a, requested);
          assertSubmission(retried, requested, head.snapshotId, true);
          assert.deepEqual(retried.fact, lost.fact);
          assert.deepEqual(retried.runtimeFact.event, lost.runtimeFact.event);
          assert.equal(records.at(-1)!.bodyHash, records[offset].bodyHash);
          assert.deepEqual(
            records.at(-1)!.factCommits?.map((row) => row.identityHash),
            records[offset].factCommits?.map((row) => row.identityHash),
          );
          assert.deepEqual(await factState(), beforeRetry);
          const changed =
            requested.kind === "ui.response"
              ? { ...requested, data: { privateValue: "changed" } }
              : {
                  ...requested,
                  patch: [
                    {
                      op: "set" as const,
                      path: ["privateValue"],
                      value: "changed",
                    },
                  ],
                };
          await rejected(
            a,
            factCommand(changed),
            409,
            "idempotency_key_reused",
          );
          assert.deepEqual(await factState(), beforeRetry);
          originalFacts.push({ requested, response: lost });
        }
      },
    );
    await run(
      "runtime fact source hashes are checked atomically against an interleaved edit",
      async () => {
        const head = await lifecycleContent(a, runtimeFacts.root);
        const stale = makePatch("stale-hash");
        const missing = makePatch(
          "missing-hash",
          runtimeFacts.root,
          head.content,
        );
        delete missing.source.sourceContentHash;
        const before = await factState();
        await rejected(a, factCommand(stale), 409, "stale_source");
        await rejected(a, factCommand(missing), 400, "source_hash_required");
        assert.deepEqual(await factState(), before);
        const raced = makePatch("raced-hash", runtimeFacts.root, head.content);
        await armFault(
          runtimeFacts.root,
          "appendRuntimeFact",
          "pause",
          "before",
        );
        const pending = a.call(factCommand(raced));
        value(await runtime.call({ action: "wait-rpc-fault" }));
        try {
          await appendRuntimeEdit(
            "hash-race-edit",
            "edit wins freshness race\n",
          );
        } finally {
          value(await runtime.call({ action: "release-rpc-fault" }));
        }
        const failure = await pending;
        assert.equal(failure.ok, false);
        assert.equal((failure as Failure).error.status, 409);
        assert.equal((failure as Failure).error.code, "stale_source");
        assert.deepEqual((await pollFacts(a)).facts, before.poll.facts);
        const after = await lifecycleContent(a, runtimeFacts.root);
        const fresh = makePatch(
          "fresh-after-race",
          runtimeFacts.root,
          after.content,
        );
        assertSubmission(await submitFact(a, fresh), fresh, after.snapshotId);
      },
    );
    await run(
      "runtime facts require sensitive branch access and remain isolated across private roots and account clones",
      async () => {
        const current = await lifecycleContent(a, runtimeFacts.root);
        const blocked = makePatch(
          "must-not-write",
          runtimeFacts.root,
          current.content,
        );
        const blockedResponse: NullplugUiResponseFact = {
          version: 1,
          kind: "ui.response",
          id: "must-not-submit",
          primitiveId: "approval",
          createdAt: 123,
          source: { ...blocked.source },
          data: { privateValue: factMarker },
        };
        const before = await factState();
        const beforePrivate = await factState(runtimeFacts.privateRoot);
        const privatePatch = makePatch(
          "must-not-write-private",
          runtimeFacts.privateRoot,
          runtimeFacts.privateInitial,
        );
        for (const token of [undefined, "invalid-session", tokens[2]]) {
          await configure(b, token, "runtime-denied");
          await rejected(
            b,
            factCommand(blocked),
            token === tokens[2] ? 403 : 401,
          );
          await rejected(
            b,
            factCommand(blockedResponse),
            token === tokens[2] ? 403 : 401,
          );
          const privateWriteOffset = records.length;
          await rejected(
            b,
            factCommand(privatePatch),
            token === tokens[2] ? 404 : 401,
          );
          assert.equal(
            records[privateWriteOffset].calls["rpc.appendRuntimeFact"],
            undefined,
          );
          if (token === tokens[2]) {
            assert.ok(records[privateWriteOffset].sqlReads > 0);
            assert.equal(
              records[privateWriteOffset].calls["rpc.readHead"].count,
              1,
            );
          }
          await rejected(
            b,
            {
              action: "request",
              path: "/api/nullplug/state",
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-nulldown-account-id": lifecycle.owner,
              },
              json: { ...blocked },
            },
            token === tokens[2] ? 403 : 401,
          );
          const ordinary = value(
            await b.call<DropDiffPollResponse>({
              action: "poll",
              rootId: runtimeFacts.root,
              branch: "owner",
              cursor: "-1",
              factCursor: null,
            }),
          );
          assert.ok(ordinary.events.length > 0);
          assert.equal(ordinary.facts, undefined);
          await rejected(
            b,
            {
              action: "poll",
              rootId: runtimeFacts.root,
              branch: "owner",
              cursor: "-1",
              factCursor: "-1",
            },
            403,
          );
          await rejected(
            b,
            {
              action: "poll",
              rootId: runtimeFacts.privateRoot,
              branch: "owner",
              cursor: "-1",
              factCursor: "-1",
            },
            404,
          );
        }
        assert.deepEqual(await factState(), before);
        assert.deepEqual(
          await factState(runtimeFacts.privateRoot),
          beforePrivate,
        );
        await configure(b, tokens[4], "runtime-writer-A");
        const firstClone = await resolveBranch(b, runtimeFacts.root);
        runtimeTargets.push({
          rootId: runtimeFacts.root,
          branch: firstClone.branchId,
        });
        const firstFact = makePatch("clone-same-id");
        firstFact.source.branchId = firstClone.branchId;
        assertSubmission(
          await submitFact(b, firstFact),
          firstFact,
          0,
          false,
          lifecycle.writer,
        );
        assert.equal(
          (await pollFacts(b, runtimeFacts.root, firstClone.branchId)).facts!
            .length,
          1,
        );
        assert.equal(
          (await pollFacts(a, runtimeFacts.root, firstClone.branchId)).facts!
            .length,
          1,
        );
        await configure(b, tokens[5], "runtime-writer-B");
        const secondClone = await resolveBranch(b, runtimeFacts.root);
        runtimeTargets.push({
          rootId: runtimeFacts.root,
          branch: secondClone.branchId,
        });
        assert.notEqual(secondClone.branchId, firstClone.branchId);
        await rejected(
          b,
          {
            action: "poll",
            rootId: runtimeFacts.root,
            branch: firstClone.branchId,
            cursor: "-1",
            factCursor: "-1",
          },
          403,
        );
        await rejected(b, factCommand(firstFact), 403, "forbidden");
        const secondFact = {
          ...firstFact,
          source: { ...firstFact.source, branchId: secondClone.branchId },
        };
        assertSubmission(
          await submitFact(b, secondFact),
          secondFact,
          0,
          false,
          lifecycle.otherWriter,
        );
        const isolated = await pollFacts(
          b,
          runtimeFacts.root,
          secondClone.branchId,
        );
        assert.equal(isolated.facts!.length, 1);
        assert.equal(isolated.facts![0].branchId, secondClone.branchId);
        assert.equal(
          isolated.facts![0].fact.metadata?.actorAccountId,
          lifecycle.otherWriter,
        );
        assert.deepEqual((await pollFacts(a)).facts, before.poll.facts);
        await configure(b, tokens[3], "runtime-B");
      },
    );
    await run(
      "201 SDK fact writes paginate independently and captured fact heads exclude later commits",
      async () => {
        await configure(b, tokens[3], "runtime-B");
        const pageRoot = runtimeFacts.pageRoot;
        const initial = await inspect("owner", pageRoot);
        const expected: DropBranchRuntimeFact[] = [];
        for (let index = 0; index < runtimeFacts.pageFactCount; index++) {
          const requested = makePatch(`page-${index}`, pageRoot);
          const stored = await submitFact(index % 2 ? b : a, requested);
          assertSubmission(stored, requested, 0);
          assert.equal(stored.runtimeFact.event.seq, index);
          expected.push(stored.runtimeFact.event);
        }
        const first = await pollFacts(b, pageRoot);
        assert.equal(first.facts!.length, 200);
        assert.equal(first.factCursor, "199");
        assert.equal(first.cursor, null);
        assert.deepEqual(first.events, []);
        const second = await pollFacts(b, pageRoot, "owner", first.factCursor!);
        assert.equal(second.facts!.length, 1);
        assert.equal(second.factCursor, "200");
        assert.deepEqual([...first.facts!, ...second.facts!], expected);
        const empty = await pollFacts(b, pageRoot, "owner", second.factCursor!);
        assert.deepEqual(empty.facts, []);
        assert.equal(empty.factCursor, null);
        const beyondHeadOffset = records.length;
        const beyondHead = await pollFacts(
          b,
          pageRoot,
          "owner",
          "9007199254740993",
        );
        assert.deepEqual(beyondHead.facts, []);
        assert.equal(beyondHead.factCursor, null);
        assert.equal(
          records[beyondHeadOffset].calls["rpc.readRuntimeFacts"],
          undefined,
        );
        const omittedOffset = records.length;
        const omitted = value(
          await b.call<DropDiffPollResponse>({
            action: "poll",
            rootId: pageRoot,
            branch: "owner",
            cursor: "-1",
            factCursor: null,
          }),
        );
        assert.equal(omitted.facts, undefined);
        assert.equal(omitted.factCursor, undefined);
        assert.equal(
          records[omittedOffset].calls["rpc.readRuntimeFactHead"],
          undefined,
        );
        assert.equal(
          records[omittedOffset].calls["rpc.readRuntimeFacts"],
          undefined,
        );
        for (const [cursor, factCursor] of [
          ["__latest__", "-1"],
          ["-1", "__latest__"],
        ]) {
          const latest = value(
            await b.call<DropDiffPollResponse>({
              action: "poll",
              rootId: pageRoot,
              branch: "owner",
              cursor,
              factCursor,
            }),
          );
          assert.deepEqual(latest.facts, []);
          assert.equal(latest.factCursor, "200");
        }
        const excluded = value(
          await b.call<DropDiffPollResponse>({
            action: "poll",
            rootId: pageRoot,
            branch: "owner",
            cursor: "-1",
            factCursor: "-1",
            factLimit: 2,
            excludeClient: "runtime-A",
          }),
        );
        assert.deepEqual(excluded.facts, expected.slice(0, 2));
        const pageState = await inspect("owner", pageRoot);
        assert.equal(
          pageState.counts.branch_snapshots,
          initial.counts.branch_snapshots,
        );
        assert.deepEqual(pageState.events, initial.events);
        assert.equal(
          (await lifecycleContent(a, pageRoot)).content,
          runtimeFacts.initial,
        );
        const before = await pollFacts(a);
        await armFault(
          runtimeFacts.root,
          "readRuntimeFactHead",
          "pause",
          "after",
        );
        const pending = pollFacts(a);
        value(await runtime.call({ action: "wait-rpc-fault" }));
        let appended: FactSubmission;
        try {
          const head = await lifecycleContent(b, runtimeFacts.root);
          appended = await submitFact(
            b,
            makePatch(
              "after-captured-fact-head",
              runtimeFacts.root,
              head.content,
            ),
          );
        } finally {
          value(await runtime.call({ action: "release-rpc-fault" }));
        }
        const captured = await pending;
        assert.deepEqual(captured.facts, before.facts);
        assert.equal(captured.factCursor, before.factCursor);
        const next = await pollFacts(
          a,
          runtimeFacts.root,
          "owner",
          captured.factCursor!,
        );
        assert.deepEqual(next.facts, [appended!.runtimeFact.event]);
      },
    );
    await run(
      "native runtime fact outbox abort and selected failures roll back without fallback or consuming a sequence",
      async () => {
        const head = await lifecycleContent(a, runtimeFacts.root);
        const candidate = makePatch(
          "selected-failure-retry",
          runtimeFacts.root,
          head.content,
        );
        const before = await factState();
        const rollback = makePatch(
          "native-fact-rollback",
          runtimeFacts.root,
          head.content,
        );
        value(
          await runtime.call({
            action: "arm-runtime-fact-sql-fault",
            rootId: runtimeFacts.root,
            branch: "owner",
          }),
        );
        try {
          await rejected(a, factCommand(rollback), 503, "state_unavailable");
          assert.deepEqual(await factState(), before);
        } finally {
          value(
            await runtime.call({
              action: "clear-runtime-fact-sql-fault",
              rootId: runtimeFacts.root,
              branch: "owner",
            }),
          );
        }
        for (const mode of ["fail", "stale-generation"] as const) {
          await armFault(
            runtimeFacts.root,
            "appendRuntimeFact",
            mode,
            "before",
          );
          const offset = records.length;
          await rejected(
            a,
            factCommand(candidate),
            mode === "fail" ? 503 : 409,
            mode === "fail"
              ? "state_unavailable"
              : "routing_generation_mismatch",
          );
          assert.equal(
            records[offset].calls["rpc.appendRuntimeFact"].errors,
            1,
          );
          assert.deepEqual(await factState(), before);
        }
        await armFault(
          runtimeFacts.root,
          "readRuntimeFactHead",
          "fail",
          "before",
        );
        await rejected(
          a,
          {
            action: "poll",
            rootId: runtimeFacts.root,
            branch: "owner",
            cursor: "-1",
            factCursor: "-1",
          },
          503,
          "state_unavailable",
        );
        assert.deepEqual(await factState(), before);
        const stored = await submitFact(a, candidate);
        assertSubmission(stored, candidate, head.snapshotId);
        assert.equal(stored.runtimeFact.event.seq, before.poll.facts!.length);
        const recovered = await submitFact(a, rollback);
        assertSubmission(recovered, rollback, head.snapshotId);
        assert.equal(
          recovered.runtimeFact.event.seq,
          stored.runtimeFact.event.seq + 1,
        );
        const durable = await inspectRuntimeFacts();
        assert.equal(durable.headSeq, recovered.runtimeFact.event.seq);
        assert.equal(
          durable.counts.branch_runtime_facts,
          before.runtime.counts.branch_runtime_facts + 2,
        );
        assert.equal(
          durable.counts.branch_runtime_fact_receipts,
          durable.counts.branch_runtime_facts,
        );
        assert.equal(
          durable.counts.branch_runtime_fact_outbox,
          durable.counts.branch_runtime_facts,
        );
        assert.deepEqual(
          durable.receipts.map((receipt) => receipt.event),
          durable.facts,
        );
        assert.deepEqual(
          durable.outbox.map((row) => row.receipt),
          durable.receipts,
        );
      },
    );
    await run(
      "runtime fact receipts survive runtime and process restart with measured local-only dependencies",
      async () => {
        const before = await factState();
        const beforePrivate = await factState(runtimeFacts.privateRoot);
        const beforePages = await inspectRuntimeFacts(runtimeFacts.pageRoot);
        const pageTail = await pollFacts(
          a,
          runtimeFacts.pageRoot,
          "owner",
          "199",
        );
        const reset = value(
          await runtime.call<{ baseUrl: string }>({ action: "reset-runtime" }),
        );
        upstream = reset.baseUrl;
        assert.deepEqual(await factState(), before);
        assert.deepEqual(
          await factState(runtimeFacts.privateRoot),
          beforePrivate,
        );
        assert.deepEqual(
          await inspectRuntimeFacts(runtimeFacts.pageRoot),
          beforePages,
        );
        const oldPid = await runtime.ready;
        await runtime.close();
        runtime = new Peer("runtime");
        await startRuntime();
        assert.notEqual(await runtime.ready, oldPid);
        assert.deepEqual(await factState(), before);
        assert.deepEqual(
          await factState(runtimeFacts.privateRoot),
          beforePrivate,
        );
        assert.deepEqual(
          await pollFacts(a, runtimeFacts.pageRoot, "owner", "199"),
          pageTail,
        );
        assert.deepEqual(
          await inspectRuntimeFacts(runtimeFacts.pageRoot),
          beforePages,
        );
        for (const original of originalFacts) {
          const duplicate = await submitFact(a, original.requested);
          assertSubmission(
            duplicate,
            original.requested,
            original.response.fact.source.snapshotId!,
            true,
          );
          assert.deepEqual(
            duplicate.runtimeFact.event,
            original.response.runtimeFact.event,
          );
        }
        assert.deepEqual(await factState(), before);
        await b.close();
        b = new Peer("client");
        value(
          await b.call({
            action: "configure",
            token: tokens[3],
            clientId: "runtime-reconnected",
            baseUrl: proxy.baseUrl,
            cursor: "-1",
            factCursor: "199",
          }),
        );
        const resumed = value(
          await b.call<DropDiffPollResponse>({
            action: "poll",
            rootId: runtimeFacts.pageRoot,
            branch: "owner",
          }),
        );
        assert.deepEqual(resumed, pageTail);
        const head = await lifecycleContent(a, runtimeFacts.root);
        const next = makePatch(
          "after-process-restart",
          runtimeFacts.root,
          head.content,
        );
        const stored = await submitFact(a, next);
        assertSubmission(stored, next, head.snapshotId);
        assert.equal(stored.runtimeFact.event.seq, before.poll.facts!.length);
        const rows = records.slice(runtimeRequestOffset);
        const steady = rows.filter((row) => row.phase === "runtime-facts");
        assert.ok(steady.length > runtimeFacts.pageFactCount);
        for (const row of steady) {
          assert.equal(row.sqlWrites, 0, row.requestId);
          assert.equal(
            Object.keys(row.calls).some((name) => name.startsWith("r2.")),
            false,
            row.requestId,
          );
          assert.equal(
            row.background.scheduled,
            row.background.completed + row.background.failed,
          );
          assert.equal(row.background.failed, 0);
        }
        assert.ok(
          steady.some((row) => row.sqlReads > 0),
          "authorization reads remain separately measured",
        );
        assert.ok(
          steady.some((row) =>
            row.rpcFailures.some((failure) => failure.code === "stale_source"),
          ),
        );
        assert.ok(
          steady.some((row) =>
            row.rpcFailures.some(
              (failure) => failure.code === "state_unavailable",
            ),
          ),
        );
        const commits = steady.flatMap((row) =>
          (row.factCommits ?? []).map((commit) => ({
            requestId: row.requestId,
            ...commit,
          })),
        );
        assert.ok(commits.some((row) => !row.appended));
        const durableSummaries = [];
        for (const { rootId, branch } of runtimeTargets) {
          const durable = await inspectRuntimeFacts(rootId, branch);
          assert.equal(durable.headSeq, durable.facts.length - 1);
          assert.equal(
            durable.counts.branch_runtime_facts,
            durable.facts.length,
          );
          assert.equal(
            durable.counts.branch_runtime_fact_receipts,
            durable.facts.length,
          );
          assert.equal(
            durable.counts.branch_runtime_fact_outbox,
            durable.facts.length,
          );
          assert.deepEqual(
            durable.receipts.map((receipt) => receipt.event),
            durable.facts,
          );
          assert.deepEqual(
            durable.outbox.map((row) => row.receipt),
            durable.receipts,
          );
          assert.equal(
            new Set(durable.outbox.map((row) => row.id)).size,
            durable.facts.length,
          );
          const receipts = durable.receipts.map((receipt, index) => {
            const identityHash = sha256(
              JSON.stringify([rootId, branch, receipt.identity]),
            );
            const correlated = commits.filter(
              (row) => row.identityHash === identityHash,
            );
            assert.equal(correlated.filter((row) => row.appended).length, 1);
            assert.ok(correlated.every((row) => row.seq === receipt.event.seq));
            assert.equal(receipt.event.seq, index);
            assert.equal(durable.outbox[index].kind, "branch.runtime-fact.v1");
            return {
              identityHash,
              seq: receipt.event.seq,
              outboxIdHash: sha256(durable.outbox[index].id),
            };
          });
          durableSummaries.push({
            scopeHash: sha256(JSON.stringify([rootId, branch])),
            headSeq: durable.headSeq,
            counts: durable.counts,
            receipts,
          });
        }
        writeFileSync(
          resolve(evidence, "application-runtime-facts.json"),
          JSON.stringify(
            {
              scope:
                "local signed SDK / actual Pages / Worker RPC / native SQLite",
              groups: 8,
              pageFactWrites: runtimeFacts.pageFactCount,
              eventCorrelation: commits,
              atomicOutboxRecords: durableSummaries,
              syntheticPayloadMarkerRegistered: sensitiveValues.has(factMarker),
              projectionIndexed: false,
              outboxDelivery: false,
              production: false,
              dependencyPhases: [...new Set(rows.map((row) => row.phase))],
              runtimeResetAndProcessRestart: true,
            },
            null,
            2,
          ),
        );
      },
    );
  } finally {
    const cleanup = await Promise.allSettled([
      a.close(),
      b.close(),
      runtime.close(),
      proxy.close(),
    ]);
    cleanup.push(...(await terminateAll("final cleanup")));
    const cleanupErrors = cleanup
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => redact(String(result.reason)));
    cleanupErrors.push(...exitCleanupErrors);
    const changedInputs = drift([
      ...inputs,
      ...Object.entries(pins.bundles).map(([name, hash]): [string, string] => [
        resolve(evidence, name),
        hash,
      ]),
    ]);
    if (managedChildren.size) cleanupErrors.push("Live child groups remain");
    writeFileSync(
      resolve(evidence, "application-lifecycle.json"),
      JSON.stringify(
        {
          shutdownEvidence,
          cleanupSignalEvidence,
          liveGroups: [...managedChildren.keys()],
          processWideOutbound,
        },
        null,
        2,
      ),
    );
    const result = {
      checks,
      pids,
      requests: records.length,
      interruptedRequests: proxy.interrupted,
      expectedGroups,
      phases: Object.fromEntries(
        [...new Set(records.map((record) => record.phase))].map((phase) => {
          const rows = records.filter((record) => record.phase === phase);
          return [
            phase,
            {
              requests: rows.length,
              r2Calls: rows.reduce(
                (sum, row) =>
                  sum +
                  Object.entries(row.calls)
                    .filter(([name]) => name.startsWith("r2."))
                    .reduce((count, [, call]) => count + call.count, 0),
                0,
              ),
              sqlReads: rows.reduce((sum, row) => sum + row.sqlReads, 0),
              sqlWrites: rows.reduce((sum, row) => sum + row.sqlWrites, 0),
            },
          ];
        }),
      ),
      pins,
      changedInputs,
      cleanupErrors,
      processWideOutbound,
      shutdownEvidence,
      allPassed: false,
      artifactSecretScan: "application-artifact-secret-scan.json",
      claims: {
        production: false,
        retainedArtifactSecretScan: false,
        loginOrRefresh: false,
        rootOwnershipProjectionCreation: checks.some(
          (check) =>
            check.name.startsWith("SDK sealed root creation") && check.passed,
        ),
        outboxDelivery: false,
        individualObjectEviction: false,
        actualProductionWorker: true,
        nativeSQLite: checks.some(
          (check) => check.name.startsWith("native SQL") && check.passed,
        ),
        runtimeResetAndProcessRestart: checks.some(
          (check) =>
            check.name.startsWith("native runtime reset") && check.passed,
        ),
      },
    };
    const resultPath = resolve(evidence, "application-result.json");
    writeFileSync(resultPath, JSON.stringify(result, null, 2));
    const artifactScan = scanRetainedArtifactSecrets();
    writeFileSync(
      resolve(evidence, result.artifactSecretScan),
      JSON.stringify(artifactScan, null, 2),
    );
    if (!artifactScan.passed)
      cleanupErrors.push("Known secret material found in retained artifacts");
    result.claims.retainedArtifactSecretScan = artifactScan.passed;
    result.allPassed =
      completeGroups() &&
      checks.every((check) => check.passed) &&
      changedInputs.length === 0 &&
      cleanupErrors.length === 0;
    // Only content-free scan metadata/booleans change after scanning the pending result.
    writeFileSync(resultPath, JSON.stringify(result, null, 2));
    if (changedInputs.length)
      console.error(
        "Source inputs changed during acceptance; rerun required",
        changedInputs,
      );
    if (
      !completeGroups() ||
      checks.some((check) => !check.passed) ||
      changedInputs.length ||
      cleanupErrors.length
    )
      process.exitCode = 1;
  }
}

networkGuard();
if (argument("mode") === "runtime") await runtimeMode();
else if (argument("mode") === "client") await clientMode();
else {
  let stopping = false;
  const stop = (code: number, reason: string) => {
    if (stopping) return;
    stopping = true;
    const hardStop = setTimeout(
      () => process.exit(code),
      shutdownDeadlineMs * 2 + 1000,
    );
    void terminateAll(reason)
      .then(() => {
        writeFileSync(
          resolve(evidence, "application-watchdog.json"),
          JSON.stringify(
            {
              reason,
              shutdownEvidence,
              liveGroups: [...managedChildren.keys()],
            },
            null,
            2,
          ),
        );
        clearTimeout(hardStop);
        process.exit(code);
      })
      .catch((error: unknown) => {
        console.error(redact(String(error)));
      });
  };
  const deadline = setTimeout(
    () => stop(124, "driver deadline"),
    harnessDeadlineMs,
  );
  process.once("SIGTERM", () => stop(143, "driver SIGTERM"));
  process.once("SIGINT", () => stop(130, "driver SIGINT"));
  // The independent launcher owns cleanup after driver exit; asynchronous
  // verification cannot safely run in Node's synchronous exit callback.
  try {
    await main();
  } catch (error) {
    console.error(redact(String(error)));
    process.exitCode = 1;
  } finally {
    await terminateAll("driver final cleanup");
    clearTimeout(deadline);
  }
}

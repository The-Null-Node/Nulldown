import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  appendFileSync,
  readFileSync,
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
} from "../../src/client/nulldown-client";
import { issueAccountSessionToken } from "../../functions/api/_lib/accounts/session/token";
import {
  branchStateShardName,
  decodeBranchStateRpcResult,
  type BranchStateRpcResult,
} from "../../packages/nulldown-state-plane/src/shard-router";
import type {
  DropDiffAppendResponse,
  DropDiffEvent,
  DropDiffPollResponse,
} from "../../shared/drop/diff";
import type { DropBranchContentResponse } from "../../shared/drop/branch";
import {
  applicationFixture as fixture,
  applicationEdits as edits,
  applicationEvent,
  applicationSeed,
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
const redact = (text: string) => {
  for (const secret of sensitiveValues)
    text = text.replaceAll(secret, "[redacted]");
  return text.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]");
};
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
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
  cursor?: string;
  limit?: number;
  excludeClient?: string;
  loseAck?: boolean;
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
}
function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
function trackChild(child: ChildProcessWithoutNullStreams): ManagedChild {
  assert.ok(child.pid, "child process started");
  const pid = child.pid;
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveExit) => {
    child.once("exit", (code, signal) => {
      // A crashed host must not leave its workerd grandchildren alive.
      signalGroup(pid, "SIGKILL");
      managedChildren.delete(pid);
      persistGroups();
      resolveExit({ code, signal });
    });
    child.once("error", () => resolveExit({ code: 1, signal: null }));
  });
  const managed = { child, exited };
  managedChildren.set(pid, managed);
  persistGroups();
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
      signalGroup(child.pid!, "SIGTERM");
      try {
        await bounded(
          managed.exited,
          shutdownDeadlineMs,
          "SIGTERM grace exceeded",
        );
      } catch {
        row.signals.push("SIGKILL");
        signalGroup(child.pid!, "SIGKILL");
        await bounded(
          managed.exited,
          shutdownDeadlineMs,
          "SIGKILL exit deadline exceeded",
        );
      }
      row.exited = true;
    } finally {
      signalGroup(child.pid!, "SIGKILL");
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      row.pipesDestroyed = true;
    }
  })();
  return managed.stopping;
}
async function terminateAll(reason: string) {
  return Promise.allSettled(
    [...managedChildren.values()].map((child) => terminate(child, reason)),
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
    if (this.process.exitCode !== null || this.process.signalCode !== null)
      return;
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
  const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } =
    runtimeRequire("miniflare") as typeof MiniflareModule;
  let mf: InstanceType<typeof Miniflare> | undefined;
  let options:
    | (MiniflareModule.V4MiniflareOptions & {
        workers: MiniflareModule.V4WorkerOptions[];
      })
    | undefined;
  let generation = 0;
  let outbound = 0;
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
            bindings: { ACCOUNT_AUTH_SECRET: command.secret! },
            r2Buckets: { R2_BUCKET: "acceptance-r2" },
            d1Databases: { DB: "acceptance-auth" },
            serviceBindings: {
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
        ],
      };
      mf = new Miniflare(convertV4MiniflareOptions(options));
      return { baseUrl: (await mf.ready).origin, pid: process.pid };
    }
    assert.ok(mf, "runtime configured");
    if (command.action === "close") {
      await mf.dispose();
      return { outbound };
    }
    if (command.action === "state-http")
      return {
        status: (
          await (await mf.getWorker("state")).fetch("https://state.invalid/")
        ).status,
      };
    const seed = applicationSeed(
      command.branch,
      command.rootId,
      command.content,
    );
    const query = {
      target: {
        rootDropId: seed.branch.rootDropId,
        branchId: seed.branch.branchId,
      },
      placement: seed.placement,
    };
    const name = await branchStateShardName(query);
    if (command.action === "seed") {
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
    if (command.action === "inspect") {
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
  let cursor = "-1",
    serial = 0,
    clientId = "",
    loseNextAck = false;
  await serveCommands(async (command) => {
    if (command.action === "configure") {
      clientId = command.clientId!;
      cursor = command.cursor ?? "-1";
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
      });
      return { pid: process.pid };
    }
    if (command.action === "close") return { closed: true, cursor };
    assert.ok(client, "client configured");
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
      if (command.excludeClient !== undefined)
        params.set("excludeClient", command.excludeClient);
      const result = (
        await client.request<DropDiffPollResponse>(
          `/api/diff/${command.rootId ?? fixture.root}?${params}`,
        )
      ).data!;
      if (result.cursor !== null) cursor = result.cursor;
      return result;
    }
    if (command.action === "request")
      return (
        await client.request(command.path!, {
          method: command.method ?? "GET",
          headers: command.headers,
          ...(command.events
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
  let lostReceipt: DropDiffAppendResponse | undefined;
  const server: Server = createServer((incoming, outgoing) => {
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
      const response = await fetch(new URL(incoming.url!, upstream()), {
        method: incoming.method,
        headers,
        ...(body.length ? { body } : {}),
        signal: AbortSignal.timeout(requestDeadlineMs),
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
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
        lostReceipt = JSON.parse(
          new TextDecoder().decode(bytes),
        ) as DropDiffAppendResponse;
        outgoing.destroy();
        return;
      }
      outgoing.writeHead(response.status, {
        "Content-Type": response.headers.get("content-type") ?? "text/plain",
      });
      outgoing.end(bytes);
    })().catch((error: unknown) => {
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
    lostReceipt: () => lostReceipt,
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
    graphs: { driver: string[]; cli: string[] };
    inputs: Record<string, string>;
    driverBundleHash: string;
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
  assert.equal(
    sha256(readFileSync(process.argv[1])),
    sourcePins.driverBundleHash,
    "executed driver hash",
  );
  for (const [entry, output] of [
    ["packages/nulldown-state-plane/src/worker.ts", "state-worker.mjs"],
    [
      "packages/nulldown-state-plane/test/application-worker.fixture.ts",
      "application-worker.mjs",
    ],
  ]) {
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
    for (const input of Object.keys(built.metafile!.inputs)) {
      const path = realpathSync(resolve(root, input));
      assert.ok(
        path.startsWith(realpathSync(root) + "/"),
        "single source checkout",
      );
      const digest = sha256(readFileSync(path));
      if (inputs.has(path))
        assert.equal(digest, inputs.get(path), "shared source pin unchanged");
      inputs.set(path, digest);
    }
  }
  const pins = {
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
          wholeRequestR2: 0,
          sqlWrites: 0,
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
  const tokens = await Promise.all(
    [fixture.owner, fixture.writer, fixture.stranger].map(
      async (id) =>
        (await issueAccountSessionToken(id, { ACCOUNT_AUTH_SECRET: secret }))
          .token,
    ),
  );
  for (const value of [secret, ...tokens]) sensitiveValues.add(value);
  const records: RequestRecord[] = [];
  const checks: {
    name: string;
    passed: boolean;
    ms: number;
    error?: string;
  }[] = [];
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
      checks.push({ name, passed: true, ms: performance.now() - start });
      console.log("PASS", name);
    } catch (error) {
      checks.push({
        name,
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
  ) =>
    value(
      await peer.call({
        action: "configure",
        token,
        clientId,
        baseUrl: proxy.baseUrl,
        cursor,
      }),
    );
  const seed = async (branch?: string, content?: string, rootId?: string) =>
    value(await runtime.call({ action: "seed", branch, content, rootId }));
  const inspect = async (branch?: string) =>
    value(await runtime.call<Inspection>({ action: "inspect", branch }));
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
          liveGroups: [...managedChildren.keys()],
          processWideOutbound,
        },
        null,
        2,
      ),
    );
    writeFileSync(
      resolve(evidence, "application-result.json"),
      JSON.stringify(
        {
          checks,
          pids,
          requests: records.length,
          pins,
          changedInputs,
          cleanupErrors,
          processWideOutbound,
          shutdownEvidence,
          allPassed:
            checks.length === 13 &&
            checks.every((check) => check.passed) &&
            changedInputs.length === 0 &&
            cleanupErrors.length === 0,
          claims: {
            production: false,
            loginOrRefresh: false,
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
        },
        null,
        2,
      ),
    );
    if (changedInputs.length)
      console.error(
        "Source inputs changed during acceptance; rerun required",
        changedInputs,
      );
    if (
      checks.length !== 13 ||
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
    void terminateAll(reason).finally(() => {
      writeFileSync(
        resolve(evidence, "application-watchdog.json"),
        JSON.stringify(
          { reason, shutdownEvidence, liveGroups: [...managedChildren.keys()] },
          null,
          2,
        ),
      );
      clearTimeout(hardStop);
      process.exit(code);
    });
  };
  const deadline = setTimeout(
    () => stop(124, "driver deadline"),
    harnessDeadlineMs,
  );
  process.once("SIGTERM", () => stop(143, "driver SIGTERM"));
  process.once("SIGINT", () => stop(130, "driver SIGINT"));
  process.once("exit", () => {
    for (const pid of managedChildren.keys()) signalGroup(pid, "SIGKILL");
  });
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

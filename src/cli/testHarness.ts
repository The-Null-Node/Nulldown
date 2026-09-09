import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Completed real CLI subprocess output. */
export interface CliProcessResult {
  /** Numeric exit status, or null when terminated by a signal. */
  status: number | null;
  /** Terminating signal, when present. */
  signal: NodeJS.Signals | null;
  /** Complete stdout text. */
  stdout: string;
  /** Complete stderr text. */
  stderr: string;
}

/** A running CLI subprocess whose stdin can be released after a test barrier. */
export interface RunningCliProcess {
  /** Writes input without closing stdin. */
  writeStdin(text: string): void;
  /** Closes stdin, optionally after writing a final value. */
  endStdin(text?: string): void;
  /** Waits until stderr contains the supplied text. */
  waitForStderr(text: string, timeoutMs?: number): Promise<void>;
  /** Waits until stdout contains the supplied text. */
  waitForStdout(text: string, timeoutMs?: number): Promise<void>;
  /** Returns true after the child exits or is terminated. */
  hasExited(): boolean;
  /** Waits for process completion and returns all captured output. */
  result(): Promise<CliProcessResult>;
  /** Sends a signal to the child process. */
  kill(signal?: NodeJS.Signals): void;
}

/** Restartable local server and real CLI subprocess harness. */
export interface CliDurabilityHarness {
  /** Persistent data directory reused across server restarts. */
  readonly dataDir: string;
  /** Bound local HTTP base URL. */
  readonly baseUrl: string;
  /** Starts the local Bun/SQLite server and waits for HTTP readiness. */
  start(mode?: CliDurabilityServerMode): Promise<void>;
  /** Signals the active local server and waits for its HTTP listener to drain. */
  stop(): Promise<CliProcessResult | null>;
  /** Waits for an active local server stderr record. */
  waitForServerStderr(text: string, timeoutMs?: number): Promise<void>;
  /** Executes a complete real CLI subprocess. */
  nd(
    args: string[],
    stdin?: string,
    client?: "a" | "b",
  ): Promise<CliProcessResult>;
  /** Starts a CLI subprocess while retaining control of stdin. */
  spawnNd(args: string[], client?: "a" | "b"): RunningCliProcess;
  /** Stops the server and removes all temporary state. */
  dispose(): Promise<void>;
}

/** Test-only local server entrypoint modes. */
export type CliDurabilityServerMode =
  | "normal"
  | "resolved-document-put-many-fails-once";

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
};

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: string,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error(message);
};

const reservePort = async (): Promise<number> =>
  await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });

const sanitizedEnvironment = (): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  for (const key of [
    "ND_CONFIG",
    "ND_TOKEN",
    "ND_DIFF_AUTH_TOKEN",
    "ND_BASE_URL",
    "ND_ACCOUNT_ID",
    "ND_CLIENT_ID",
    "ND_REQUEST_TIMEOUT_MS",
    "DIFF_WEBHOOK_SECRET",
    "METADATA_BACKFILL_TOKEN",
    "DROP_INDEX_BACKFILL_TOKEN",
    "BRANCH_HEAP_BACKFILL_TOKEN",
  ]) {
    delete environment[key];
  }
  return environment;
};

const captureProcess = (
  child: ChildProcessWithoutNullStreams,
): RunningCliProcess => {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const completion = new Promise<CliProcessResult>((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => {
      resolveResult({ status, signal, stdout, stderr });
    });
  });

  const waitForOutput = async (
    stream: "stdout" | "stderr",
    text: string,
    timeoutMs: number,
  ): Promise<void> => {
    const read = () => (stream === "stdout" ? stdout : stderr);
    await waitFor(
      () =>
        read().includes(text) ||
        child.exitCode !== null ||
        child.signalCode !== null,
      timeoutMs,
      `Timed out waiting for CLI ${stream}: ${text}\n${read()}`,
    );
    if (!read().includes(text)) {
      const result = await completion;
      throw new Error(
        `CLI exited before ${stream} contained ${text}: ${JSON.stringify(result)}`,
      );
    }
  };

  return {
    writeStdin: (text) => child.stdin.write(text),
    endStdin(text) {
      if (text !== undefined) child.stdin.write(text);
      child.stdin.end();
    },
    async waitForStderr(text, timeoutMs = 20_000) {
      await waitForOutput("stderr", text, timeoutMs);
    },
    waitForStdout: (text, timeoutMs = 20_000) =>
      waitForOutput("stdout", text, timeoutMs),
    hasExited: () => child.exitCode !== null || child.signalCode !== null,
    result: () => completion,
    kill: (signal = "SIGTERM") => {
      child.kill(signal);
    },
  };
};

/** Creates an isolated restart-capable real CLI integration harness. */
export const createCliDurabilityHarness = async (): Promise<CliDurabilityHarness> => {
  const repoRoot = resolve(process.cwd());
  const cliPath = resolve(repoRoot, "bin/nulldown.ts");
  const resolvedProjectionFailureCliPath = resolve(
    repoRoot,
    "scripts/test-fixtures/serve-resolved-putmany-failure.ts",
  );
  const migrationsDir = resolve(repoRoot, "migrations");
  const rootDir = await mkdtemp(join(tmpdir(), "nulldown-cli-durability-"));
  const dataDir = resolve(rootDir, "data");
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const accountId = "cli-durability-account";
  const environment = sanitizedEnvironment();
  let serverProcess: RunningCliProcess | null = null;
  const cliProcesses = new Set<RunningCliProcess>();

  const spawnCli = (
    args: string[],
    tracked = true,
    entrypoint = cliPath,
  ): RunningCliProcess => {
    const running = captureProcess(
      spawn("bun", [entrypoint, ...args], {
        cwd: rootDir,
        env: environment,
        stdio: "pipe",
      }),
    );
    if (tracked) {
      cliProcesses.add(running);
      void running.result().then(
        () => cliProcesses.delete(running),
        () => cliProcesses.delete(running),
      );
    }
    return running;
  };

  const harness: CliDurabilityHarness = {
    dataDir,
    baseUrl,
    async start(mode = "normal") {
      if (serverProcess) throw new Error("CLI durability server is already running.");
      const running = spawnCli(
        [
          "serve",
          "--host=127.0.0.1",
          `--port=${port}`,
          `--data-dir=${dataDir}`,
          `--migrations-dir=${migrationsDir}`,
          "--log-level=error",
          "--json",
        ],
        false,
        mode === "resolved-document-put-many-fails-once"
          ? resolvedProjectionFailureCliPath
          : cliPath,
      );
      serverProcess = running;
      try {
        await running.waitForStdout(`"baseUrl": "${baseUrl}"`, 30_000);
        await waitFor(
          async () => {
            if (running.hasExited()) {
              const result = await running.result();
              throw new Error(
                `Local Nulldown server exited during readiness: ${JSON.stringify(result)}`,
              );
            }
            try {
              const response = await fetch(`${baseUrl}/api/list?limit=1`);
              return response.ok;
            } catch {
              return false;
            }
          },
          30_000,
          "Timed out waiting for the local Nulldown server.",
        );
      } catch (error) {
        running.kill("SIGKILL");
        const result = await running.result();
        serverProcess = null;
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} ${JSON.stringify(result)}`,
        );
      }
    },
    async stop() {
      const running = serverProcess;
      if (!running) return null;
      running.kill("SIGTERM");
      const timeout = Symbol("timeout");
      let timeoutHandle: ReturnType<typeof setTimeout>;
      const timeoutResult = new Promise<typeof timeout>((resolveTimeout) => {
        timeoutHandle = setTimeout(() => resolveTimeout(timeout), 10_000);
      });
      const result = await Promise.race([running.result(), timeoutResult]);
      clearTimeout(timeoutHandle!);
      if (result === timeout) {
        running.kill("SIGKILL");
        await running.result();
        serverProcess = null;
        throw new Error("Local Nulldown server did not stop gracefully.");
      }
      serverProcess = null;
      if (result.status !== 0 || result.signal !== null) {
        throw new Error(`Local Nulldown server exited unexpectedly: ${JSON.stringify(result)}`);
      }
      return result;
    },
    async waitForServerStderr(text, timeoutMs) {
      if (!serverProcess) throw new Error("CLI durability server is not running.");
      await serverProcess.waitForStderr(text, timeoutMs);
    },
    spawnNd(args, client = "a") {
      const clientId = `cli-durability-${client}`;
      return spawnCli([
        ...args,
        `--base=${baseUrl}`,
        `--account=${accountId}`,
        `--client=${clientId}`,
        `--config-dir=${resolve(rootDir, `config-${client}`)}`,
        "--timeout-ms=20000",
        "--json",
      ]);
    },
    async nd(args, stdin = "", client = "a") {
      const running = harness.spawnNd(args, client);
      running.endStdin(stdin);
      return await running.result();
    },
    async dispose() {
      try {
        const activeCliProcesses = [...cliProcesses];
        for (const running of activeCliProcesses) running.kill("SIGKILL");
        await Promise.allSettled(
          activeCliProcesses.map((running) => running.result()),
        );
        cliProcesses.clear();
        await harness.stop();
      } finally {
        await rm(rootDir, { recursive: true, force: true });
      }
    },
  };

  return harness;
};

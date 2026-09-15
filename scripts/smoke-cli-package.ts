import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  constants,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface CommandResult {
  error: string | null;
  signal: NodeJS.Signals | null;
  status: number | null;
  stderr: string;
  stdout: string;
}

interface PackEntry {
  filename?: string;
  integrity?: string;
  name?: string;
  shasum?: string;
  version?: string;
}

interface RunningProcess {
  hasExited(): boolean;
  result(): Promise<CommandResult>;
  stderr(): string;
  stdout(): string;
  stop(): Promise<CommandResult>;
}

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const canaryToken = "package-smoke-canary-token";

const assert = (condition: unknown, message: string): asserts condition => {
  if (!condition) throw new Error(message);
};

const sanitize = (value: string): string =>
  value.split(canaryToken).join("[redacted]");

const summarize = (result: CommandResult): Record<string, unknown> => ({
  error: result.error,
  signal: result.signal,
  status: result.status,
  stderr: sanitize(result.stderr),
  stdout: sanitize(result.stdout),
});

const run = async (
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input?: string,
): Promise<CommandResult> =>
  await new Promise((resolveResult) => {
    const child = spawn(command, args, { cwd, env, stdio: "pipe" }) as ChildProcessWithoutNullStreams;
    let settled = false;
    let stdout = "";
    let stderr = "";
    const settle = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      settle({ error: error.message, signal: null, status: null, stderr, stdout });
    });
    child.once("close", (status, signal) => {
      settle({ error: null, signal, status, stderr, stdout });
    });
    child.stdin.end(input);
  });

const runChecked = async (
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input?: string,
): Promise<CommandResult> => {
  const result = await run(command, args, cwd, env, input);
  if (result.status !== 0 || result.signal !== null || result.error) {
    throw new Error(
      `Command failed: ${command} ${args.join(" ")}\n${JSON.stringify(summarize(result))}`,
    );
  }
  return result;
};

const waitFor = async (
  predicate: () => boolean,
  timeoutMs: number,
  message: string,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(message);
};

const reservePort = async (): Promise<number> =>
  await new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });

const isolatedEnvironment = (tempRoot: string): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  for (const key of [
    "ND_ACCOUNT_ID",
    "ND_BASE_URL",
    "ND_CLIENT_ID",
    "ND_CONFIG",
    "ND_CONFIG_DIR",
    "ND_DATA_DIR",
    "ND_DIFF_AUTH_DIR",
    "ND_DIFF_AUTH_TOKEN",
    "ND_DIFF_AUTH_TOKEN_FILE",
    "ND_MIGRATIONS_DIR",
    "ND_REQUEST_TIMEOUT_MS",
    "ND_SERVE_HOST",
    "ND_SERVE_PORT",
    "ND_TOKEN",
    "BRANCH_HEAP_BACKFILL_TOKEN",
    "DIFF_WEBHOOK_SECRET",
    "DROP_INDEX_BACKFILL_TOKEN",
    "METADATA_BACKFILL_TOKEN",
    "NPM_TOKEN",
  ]) {
    delete environment[key];
  }
  for (const key of Object.keys(environment)) {
    if (/^NPM_CONFIG_.*(?:AUTH|TOKEN|PASSWORD)/i.test(key)) {
      delete environment[key];
    }
  }
  environment.HOME = join(tempRoot, "home");
  environment.XDG_CONFIG_HOME = join(tempRoot, "xdg-config");
  environment.NPM_CONFIG_CACHE = join(tempRoot, "npm-cache");
  environment.NPM_CONFIG_USERCONFIG = join(tempRoot, "empty.npmrc");
  return environment;
};

const startProcess = (
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): RunningProcess => {
  const child = spawn(command, args, { cwd, env, stdio: "pipe" }) as ChildProcessWithoutNullStreams;
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
  const completion = new Promise<CommandResult>((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => {
      resolveResult({ error: null, signal, status, stderr, stdout });
    });
  });

  return {
    hasExited: () => child.exitCode !== null || child.signalCode !== null,
    result: () => completion,
    stderr: () => stderr,
    stdout: () => stdout,
    async stop() {
      child.kill("SIGTERM");
      const timeout = Symbol("timeout");
      let timeoutHandle: ReturnType<typeof setTimeout>;
      const timed = new Promise<typeof timeout>((resolveTimeout) => {
        timeoutHandle = setTimeout(() => resolveTimeout(timeout), 10_000);
      });
      const result = await Promise.race([completion, timed]);
      clearTimeout(timeoutHandle!);
      if (result === timeout) {
        child.kill("SIGKILL");
        return await completion;
      }
      return result;
    },
  };
};

const closeServer = async (server: Server): Promise<void> =>
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });

const startFixture = async (): Promise<{
  baseUrl: string;
  close(): Promise<void>;
  deniedAuthorization: () => string | undefined;
}> => {
  let authorization: string | undefined;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    response.setHeader("Content-Type", "application/json");
    if (path === "/success/api/list") {
      response.end(JSON.stringify({ items: [canaryToken], cursor: null }));
      return;
    }
    if (path === "/denied/api/list") {
      authorization = request.headers.authorization;
      response.statusCode = 401;
      response.end(JSON.stringify({ error: `Denied ${canaryToken}`, code: "auth_failed" }));
      return;
    }
    if (path === "/invalid/api/list") {
      response.statusCode = 200;
      response.end("{not-json");
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "Not found", code: "not_found" }));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
    deniedAuthorization: () => authorization,
  };
};

const parseSingleJson = <T>(text: string): T | null => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

const parseArgs = (): { tarballPath: string | null } => {
  const args = process.argv.slice(2);
  if (args.length === 0) return { tarballPath: null };
  if (args.length === 2 && args[0] === "--tarball") {
    return { tarballPath: resolve(args[1]!) };
  }
  throw new Error("Usage: bun run scripts/smoke-cli-package.ts [--tarball <path>]");
};

const main = async (): Promise<void> => {
  const { tarballPath: suppliedTarballPath } = parseArgs();
  const tempRoot = await mkdtemp(join(tmpdir(), "nulldown-cli-package-"));
  const environment = isolatedEnvironment(tempRoot);
  const runningProcesses = new Set<RunningProcess>();
  let fixture: Awaited<ReturnType<typeof startFixture>> | null = null;

  try {
    await writeFile(environment.NPM_CONFIG_USERCONFIG!, "");
    let tarballPath = suppliedTarballPath ?? join(tempRoot, "artifact", "nulldown.tgz");
    let packEntry: PackEntry | null = null;

    if (suppliedTarballPath) {
      await access(tarballPath, constants.R_OK);
    } else {
      await mkdir(join(tempRoot, "artifact"), { recursive: true });
      const packed = await runChecked(
        "npm",
        ["pack", "--json", "--pack-destination", join(tempRoot, "artifact")],
        repoRoot,
        environment,
      );
      [packEntry] = JSON.parse(packed.stdout) as PackEntry[];
      assert(packEntry?.filename, "npm pack did not return an artifact filename.");
      assert(packEntry.name === "@thenullnode/nulldown", "Packed artifact has the wrong package name.");
      tarballPath = join(tempRoot, "artifact", packEntry.filename);
    }

    const archive = await readFile(tarballPath);
    const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
    const sha256 = createHash("sha256").update(archive).digest("hex");
    if (packEntry?.integrity) {
      assert(packEntry.integrity === integrity, "npm pack integrity did not match the tested tarball.");
    }

    const installDir = join(tempRoot, "install");
    const invocationDir = join(tempRoot, "outside-package");
    await mkdir(join(invocationDir, "migrations"), { recursive: true });
    await mkdir(installDir, { recursive: true });
    await writeFile(join(installDir, "package.json"), '{"private":true,"type":"module"}\n');
    await writeFile(join(invocationDir, "migrations", "9999_invalid.sql"), "invalid sql;\n");
    await runChecked(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        tarballPath,
      ],
      installDir,
      environment,
    );

    const installedPackageDir = join(installDir, "node_modules", "@thenullnode", "nulldown");
    const installedManifest = JSON.parse(
      await Bun.file(join(installedPackageDir, "package.json")).text(),
    ) as { version: string };
    const nd = join(installDir, "node_modules", ".bin", "nd");
    const nulldown = join(installDir, "node_modules", ".bin", "nulldown");
    await access(nd, constants.X_OK);
    await access(nulldown, constants.X_OK);

    for (const bin of [nd, nulldown]) {
      const version = await runChecked(bin, ["--version"], invocationDir, environment);
      assert(version.stdout === `${installedManifest.version}\n`, `${bin} did not print the installed package version exactly.`);
      assert(version.stderr === "", `${bin} wrote version output to stderr.`);
    }

    const unknown = await run(nd, ["unknown-command", "--json"], invocationDir, environment);
    assert(unknown.status === 1 && unknown.stdout === "", "Installed CLI failure did not preserve stdout/exit contract.");
    assert(
      JSON.stringify(parseSingleJson(unknown.stderr)) ===
        JSON.stringify({ error: "Unknown command: unknown-command", code: "unknown_command" }),
      "Installed CLI failure did not preserve structured stderr.",
    );
    const verboseUnknown = await run(
      nd,
      ["unknown-command", "--json", "--verbose"],
      invocationDir,
      environment,
    );
    const verboseRecords = verboseUnknown.stderr
      .trim()
      .split("\n")
      .map((line) => parseSingleJson<Record<string, unknown>>(line));
    assert(
      verboseUnknown.status === 1 &&
        verboseUnknown.stdout === "" &&
        verboseRecords.every(Boolean) &&
        verboseRecords[0]?.type === "diagnostic" &&
        verboseRecords.at(-1)?.code === "unknown_command",
      "Installed CLI verbose JSON did not emit a complete NDJSON stderr stream.",
    );

    fixture = await startFixture();
    const success = await runChecked(
      nd,
      ["list", `--base=${fixture.baseUrl}/success`, "--json"],
      invocationDir,
      environment,
    );
    assert(success.stderr === "", "Installed successful JSON command wrote diagnostics to stderr.");
    assert(success.stdout.includes(canaryToken), "Installed command changed successful response data.");
    const denied = await run(
      nd,
      ["list", `--base=${fixture.baseUrl}/denied`, "--token", canaryToken, "--json", "--verbose"],
      invocationDir,
      environment,
    );
    assert(denied.status === 1 && denied.stdout === "", "Installed failed request did not preserve stdout/exit contract.");
    assert(!denied.stderr.includes(canaryToken), "Installed diagnostics leaked a credential canary.");
    assert(fixture.deniedAuthorization() === `Bearer ${canaryToken}`, "Installed CLI did not send the requested authorization token.");
    const invalid = await run(
      nd,
      ["list", `--base=${fixture.baseUrl}/invalid`, "--json"],
      invocationDir,
      environment,
    );
    assert(
      invalid.status === 1 &&
        parseSingleJson<Record<string, unknown>>(invalid.stderr)?.code === "invalid_json_response",
      "Installed CLI did not preserve invalid JSON response handling.",
    );
    await fixture.close();
    fixture = null;

    await runChecked(
      "bun",
      [
        "-e",
        "await import('@thenullnode/nulldown/nullmem'); await import('@thenullnode/nulldown/server/local'); await import('@thenullnode/nulldown/server/bun-sqlite-store');",
      ],
      installDir,
      environment,
    );

    const expectedMigrations = (await readdir(join(repoRoot, "migrations")))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const port = await reservePort();
    const dataDir = join(tempRoot, "data");
    const startServer = async (): Promise<{ process: RunningProcess; baseUrl: string }> => {
      const baseUrl = `http://127.0.0.1:${port}`;
      const process = startProcess(
        nd,
        [
          "serve",
          "--host=127.0.0.1",
          `--port=${port}`,
          `--data-dir=${dataDir}`,
          "--log-level=error",
          "--json",
        ],
        invocationDir,
        environment,
      );
      runningProcesses.add(process);
      await waitFor(
        () => Boolean(parseSingleJson<{ baseUrl?: string }>(process.stdout())?.baseUrl),
        30_000,
        `Installed nd serve did not start: ${sanitize(process.stderr())}`,
      );
      if (process.hasExited()) {
        throw new Error(`Installed nd serve exited during startup: ${JSON.stringify(summarize(await process.result()))}`);
      }
      const startup = parseSingleJson<{
        baseUrl: string;
        migrationsApplied: string[];
        sqlite: boolean;
      }>(process.stdout());
      assert(startup, "Installed nd serve did not print a JSON startup record.");
      assert(startup.baseUrl === baseUrl, "Installed nd serve reported an unexpected base URL.");
      assert(startup.sqlite, "Installed nd serve did not enable SQLite by default.");
      assert(
        JSON.stringify(startup.migrationsApplied) === JSON.stringify(expectedMigrations),
        "Installed nd serve did not apply the packaged migration set.",
      );
      const readiness = await fetch(`${baseUrl}/api/list?limit=1`);
      assert(readiness.ok, "Installed nd serve did not answer readiness requests.");
      return { process, baseUrl };
    };

    const first = await startServer();
    const commandArgs = [
      `--base=${first.baseUrl}`,
      "--account=package-smoke-account",
      "--client=package-smoke-client",
      `--config-dir=${join(tempRoot, "cli-config")}`,
      "--json",
    ];
    const created = await runChecked(
      nd,
      ["create", "-", ...commandArgs],
      invocationDir,
      environment,
      "# Packaged Durable Root\n",
    );
    const createdBody = parseSingleJson<{ id?: string }>(created.stdout);
    assert(createdBody?.id, "Installed nd create did not return a root ID.");
    const initialRead = await runChecked(
      nd,
      ["get", createdBody.id, "--raw", ...commandArgs],
      invocationDir,
      environment,
    );
    assert(
      initialRead.stdout === "# Packaged Durable Root\n\n",
      `Installed nd get did not return stored content: ${JSON.stringify(initialRead.stdout)}`,
    );
    const firstStop = await first.process.stop();
    runningProcesses.delete(first.process);
    assert(firstStop.status === 0 && firstStop.signal === null, "Installed nd serve did not exit cleanly after SIGTERM.");

    const second = await startServer();
    const restartedRead = await runChecked(
      nulldown,
      ["get", createdBody.id, "--raw", ...commandArgs],
      invocationDir,
      environment,
    );
    assert(
      restartedRead.stdout === "# Packaged Durable Root\n\n",
      `Installed nulldown alias did not read durable restarted state: ${JSON.stringify(restartedRead.stdout)}`,
    );
    const secondStop = await second.process.stop();
    runningProcesses.delete(second.process);
    assert(secondStop.status === 0 && secondStop.signal === null, "Restarted installed nd serve did not exit cleanly after SIGTERM.");

    console.log(
      JSON.stringify(
        {
          package: "@thenullnode/nulldown",
          version: installedManifest.version,
          source: suppliedTarballPath ? "supplied-tarball" : "local-pack",
          integrity,
          sha256,
          assertions: [
            "installed aliases are executable and report the package version",
            "installed stdout, stderr, exit, verbose, and redaction contracts hold",
            "installed package exports load",
            "installed serve uses package migrations outside the repository",
            "installed serve persists local data across restart",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      if (fixture) await fixture.close();
    } finally {
      try {
        const activeProcesses = [...runningProcesses];
        await Promise.allSettled(activeProcesses.map((process) => process.stop()));
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    }
  }
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

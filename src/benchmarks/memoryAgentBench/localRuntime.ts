import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createNulldownClient,
  type NulldownClient,
} from "../../client/nulldownClient";
import {
  applySqliteMigrations,
  createBunSqliteStore,
  type BunSqliteStore,
} from "../../server/bunSqliteStore";
import { createLocalNulldownServer } from "../../server/local";
import { createMemoryAgentBenchRun } from "./harness";
import type { MemoryAgentBenchRun } from "./types";

type BenchListener = ReturnType<typeof Bun.serve>;

export interface LocalMemoryAgentBenchRuntimeOptions {
  temporaryDirectory?: string;
  serve?: (options: Parameters<typeof Bun.serve>[0]) => BenchListener;
}

export interface LocalMemoryAgentBenchRuntime {
  readonly dataDir: string;
  readonly baseUrl: string;
  readonly client: NulldownClient;
  createRun(): Promise<MemoryAgentBenchRun>;
  restart(): Promise<void>;
  close(): Promise<void>;
}

const migrationsDir = fileURLToPath(
  new URL("../../../migrations/", import.meta.url),
);

export const createLocalMemoryAgentBenchRuntime = async (
  options: LocalMemoryAgentBenchRuntimeOptions = {},
): Promise<LocalMemoryAgentBenchRuntime> => {
  const dataDir = await mkdtemp(
    join(options.temporaryDirectory ?? tmpdir(), "nulldown-memory-agent-bench-"),
  );
  const accountId = `memory-agent-bench-${randomUUID()}`;
  const clientId = `memory-agent-bench-${randomUUID()}`;
  const serve = options.serve ?? ((input) => Bun.serve(input));
  let sqlite: BunSqliteStore | null = null;
  let listener: BenchListener | null = null;
  let port: number | null = null;
  let client: NulldownClient | null = null;
  let closed = false;
  let runCreated = false;

  const stopProcessState = async (): Promise<void> => {
    const activeListener = listener;
    const activeSqlite = sqlite;
    listener = null;
    sqlite = null;
    try {
      await activeListener?.stop();
    } finally {
      activeSqlite?.close();
    }
  };

  const startProcessState = async (): Promise<void> => {
    const nextSqlite = await createBunSqliteStore({
      databasePath: join(dataDir, "metadata.sqlite"),
    });
    let nextListener: BenchListener | null = null;
    try {
      await applySqliteMigrations(nextSqlite, migrationsDir);
      const server = createLocalNulldownServer({
        dataDir,
        publicBaseUrl: "http://127.0.0.1",
        sql: nextSqlite,
        logLevel: "error",
      });
      nextListener = serve({
        hostname: "127.0.0.1",
        // Reuse the address so an existing run's client survives a restart.
        port: port ?? 0,
        fetch: (request) => server.fetch(request),
      });
      sqlite = nextSqlite;
      listener = nextListener;
      port = nextListener.port;
      client = createNulldownClient({
        baseUrl: `http://127.0.0.1:${port}`,
        accountId,
        clientId,
        diffAuthToken: null,
        diffWebhookSecret: null,
      });
    } catch (error) {
      try {
        await nextListener?.stop();
      } finally {
        nextSqlite.close();
      }
      throw error;
    }
  };

  try {
    await startProcessState();
  } catch (error) {
    await stopProcessState().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }

  const runtime: LocalMemoryAgentBenchRuntime = {
    dataDir,
    get baseUrl() {
      if (port === null) {
        throw new Error("MemoryAgentBench runtime is not started.");
      }
      return `http://127.0.0.1:${port}`;
    },
    get client() {
      if (!client) {
        throw new Error("MemoryAgentBench runtime is not started.");
      }
      return client;
    },
    async createRun() {
      if (closed || !client) {
        throw new Error("MemoryAgentBench runtime is closed.");
      }
      if (runCreated) {
        throw new Error("MemoryAgentBench runtime already owns a run.");
      }
      // Reserve ownership before awaiting root creation, including uncertain failures.
      runCreated = true;
      return createMemoryAgentBenchRun({ client });
    },
    async restart() {
      if (closed) {
        throw new Error("MemoryAgentBench runtime is closed.");
      }
      await stopProcessState();
      try {
        await startProcessState();
      } catch (error) {
        await stopProcessState().catch(() => undefined);
        throw error;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await stopProcessState();
      } finally {
        client = null;
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  };
  return runtime;
};

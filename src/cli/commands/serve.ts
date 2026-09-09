import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { VoidDataStore } from "../../server/ports";
import { flagString, hasFlag } from "../core/args";
import type { CliCommand } from "../core/command";

const parseServePort = (value: string | null): number => {
  const port = Number.parseInt(value || "8788", 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error("Serve port must be between 1 and 65535.");
  }
  return port;
};

/** Dependencies used by the modular serve command. */
export interface ServeCommandDependencies {
  /** Prints command output using the active CLI output policy. */
  print(value: unknown, human?: string): void;
  /** Optional programmatic store used by embedded local-server hosts. */
  data?: VoidDataStore;
}

/** Creates the modular local server command. */
export const createServeCommand = <TConfig>(
  dependencies: ServeCommandDependencies,
): CliCommand<TConfig> => ({
  name: "serve",
  async run({ args }) {
    const host =
      flagString(args, "host") || process.env.ND_SERVE_HOST || "127.0.0.1";
    const port = parseServePort(
      flagString(args, "port") || process.env.ND_SERVE_PORT || null,
    );
    const dataDir = resolve(
      flagString(args, "data-dir") || process.env.ND_DATA_DIR || ".nulldown-data",
    );
    const logLevel =
      flagString(args, "log-level") || process.env.LOG_LEVEL || "warn";
    const configuredMigrationsDir =
      flagString(args, "migrations-dir") || process.env.ND_MIGRATIONS_DIR;
    // Defaults must stay with the installed package, not the operator's CWD.
    const migrationsDir = configuredMigrationsDir
      ? resolve(configuredMigrationsDir)
      : fileURLToPath(new URL("../../../migrations/", import.meta.url));
    const { createLocalNulldownServer, localNulldownServerBaseUrl } =
      await import("../../server/local");
    const sqliteEnabled = !hasFlag(args, "no-sqlite");
    const sqlite = sqliteEnabled
      ? await (async () => {
          const module = await import("../../server/bunSqliteStore");
          const sql = await module.createBunSqliteStore({
            databasePath: resolve(dataDir, "metadata.sqlite"),
          });
          try {
            const migrationsApplied = await module.applySqliteMigrations(
              sql,
              migrationsDir,
            );
            return { sql, migrationsApplied };
          } catch (error) {
            sql.close();
            throw error;
          }
        })()
      : null;
    const publicBaseUrl =
      flagString(args, "public-base-url") ||
      localNulldownServerBaseUrl(host, port);
    let listener: ReturnType<typeof Bun.serve> | null = null;
    let shutdown: (() => void) | null = null;
    try {
      const server = createLocalNulldownServer({
        dataDir,
        publicBaseUrl,
        logLevel,
        sql: sqlite?.sql,
        data: dependencies.data,
      });
      listener = Bun.serve({
        hostname: host,
        port,
        fetch: (request) => server.fetch(request),
      });
      let resolveShutdown!: () => void;
      const shutdownPromise = new Promise<void>((resolvePromise) => {
        resolveShutdown = resolvePromise;
      });
      shutdown = () => resolveShutdown();
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      const served = {
        host,
        port: listener.port,
        dataDir,
        baseUrl: publicBaseUrl,
        sqlite: Boolean(sqlite),
        databasePath: sqlite?.sql.databasePath ?? null,
        migrationsApplied: sqlite?.migrationsApplied ?? [],
      };
      dependencies.print(
        served,
        `nulldown serving ${publicBaseUrl} using ${dataDir}`,
      );

      await shutdownPromise;
    } finally {
      if (shutdown) {
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
      }
      try {
        await listener?.stop();
      } finally {
        sqlite?.sql.close();
      }
    }
  },
});

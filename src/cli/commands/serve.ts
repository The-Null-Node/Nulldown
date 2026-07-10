import { resolve } from "node:path";
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
    const migrationsDir = resolve(
      flagString(args, "migrations-dir") ||
        process.env.ND_MIGRATIONS_DIR ||
        "migrations",
    );
    const { createLocalNulldownServer, localNulldownServerBaseUrl } =
      await import("../../server/local");
    const sqliteEnabled = !hasFlag(args, "no-sqlite");
    const sqlite = sqliteEnabled
      ? await import("../../server/bunSqliteStore").then(async (module) => {
          const sql = await module.createBunSqliteStore({
            databasePath: resolve(dataDir, "metadata.sqlite"),
          });
          const migrationsApplied = await module.applySqliteMigrations(
            sql,
            migrationsDir,
          );
          return { sql, migrationsApplied };
        })
      : null;
    const publicBaseUrl =
      flagString(args, "public-base-url") ||
      localNulldownServerBaseUrl(host, port);
    const server = createLocalNulldownServer({
      dataDir,
      publicBaseUrl,
      logLevel,
      sql: sqlite?.sql,
    });

    const listener = Bun.serve({
      hostname: host,
      port,
      fetch: (request) => server.fetch(request),
    });
    const served = {
      host,
      port: listener.port,
      dataDir,
      baseUrl: publicBaseUrl,
      sqlite: Boolean(sqlite),
      databasePath: sqlite?.sql.databasePath ?? null,
      migrationsApplied: sqlite?.migrationsApplied ?? [],
    };
    dependencies.print(served, `nulldown serving ${publicBaseUrl} using ${dataDir}`);

    await new Promise<void>(() => undefined);
  },
});

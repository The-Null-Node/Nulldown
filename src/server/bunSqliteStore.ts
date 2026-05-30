import { mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import type {
  VoidSqlBindableValue,
  VoidSqlRows,
  VoidSqlStatement,
  VoidSqlStore,
} from "./ports";

type BunSqliteBindable = string | number | null | Uint8Array;

/** Bun SQLite implementation of the portable SQL metadata store. */
export interface BunSqliteStore extends VoidSqlStore {
  /** Absolute or relative path to the SQLite database file. */
  databasePath: string;
  /** Executes raw SQL text, including multi-statement migration files. */
  exec(sql: string): void;
  /** Closes the underlying SQLite database. */
  close(): void;
}

/** Options for creating a Bun-backed SQLite metadata store. */
export interface CreateBunSqliteStoreOptions {
  /** Path to the SQLite database file. */
  databasePath: string;
}

const normalizeBindable = (value: VoidSqlBindableValue): BunSqliteBindable => {
  if (value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" || typeof value === "number") return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value;
};

class BunSqliteStatement implements VoidSqlStatement {
  private readonly statement: ReturnType<Database["query"]>;
  private values: BunSqliteBindable[] = [];

  constructor(statement: ReturnType<Database["query"]>) {
    this.statement = statement;
  }

  /** Binds positional values for the next statement execution. */
  bind(...values: VoidSqlBindableValue[]): VoidSqlStatement {
    this.values = values.map(normalizeBindable);
    return this;
  }

  /** Executes a statement that does not need rows. */
  async run(): Promise<unknown> {
    return this.statement.run(...this.values);
  }

  /** Reads the first row returned by a query. */
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | null | undefined) ?? null;
  }

  /** Reads all rows returned by a query. */
  async all<T = Record<string, unknown>>(): Promise<VoidSqlRows<T>> {
    return { results: this.statement.all(...this.values) as T[] };
  }
}

/** Creates a Bun SQLite store that satisfies the portable `VoidSqlStore` port. */
export const createBunSqliteStore = async ({
  databasePath,
}: CreateBunSqliteStoreOptions): Promise<BunSqliteStore> => {
  await mkdir(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath, { create: true });
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

  return {
    databasePath,
    prepare: (sql) => new BunSqliteStatement(database.query(sql)),
    batch: async (statements) => Promise.all(statements.map((statement) => statement.run())),
    exec: (sql) => {
      database.exec(sql);
    },
    close: () => {
      database.close();
    },
  };
};

/** Applies all `.sql` migrations in lexical filename order. Migrations must be idempotent. */
export const applySqliteMigrations = async (
  store: Pick<BunSqliteStore, "exec">,
  migrationsDir: string,
): Promise<string[]> => {
  const files = (await readdir(migrationsDir))
    .filter((entry) => entry.endsWith(".sql"))
    .sort();
  for (const file of files) {
    store.exec(await readFile(join(migrationsDir, file), "utf8"));
  }
  return files;
};

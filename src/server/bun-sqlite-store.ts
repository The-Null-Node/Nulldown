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
    batch: async (statements) =>
      Promise.all(statements.map((statement) => statement.run())),
    exec: (sql) => {
      database.exec(sql);
    },
    close: () => {
      database.close();
    },
  };
};

interface SqlToken {
  key: string;
  start: number;
  end: number;
}

// Keep literals and quoted identifiers intact; comments and whitespace are not schema.
const tokenizeSql = (sql: string): SqlToken[] => {
  const pattern = /\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9$]*|[0-9]+(?:\.[0-9]+)?|[^\s]/gy;
  const tokens: SqlToken[] = [];
  for (const match of sql.matchAll(pattern)) {
    const text = match[0];
    if (/^(?:\s|--|\/\*)/.test(text)) continue;
    const key = /^[\'"`\[]/.test(text) ? text : text.toLowerCase();
    tokens.push({ key, start: match.index, end: match.index + text.length });
  }
  return tokens;
};

const migrationStatements = (sql: string): SqlToken[][] => {
  const statements: SqlToken[][] = [];
  let current: SqlToken[] = [];
  let triggerDepth = 0;
  for (const token of tokenizeSql(sql)) {
    const isTrigger = current[0]?.key === "create" &&
      current.slice(1, 3).some(({ key }) => key === "trigger");
    if (isTrigger) {
      if (token.key === "begin" || token.key === "case") triggerDepth += 1;
      if (token.key === "end") triggerDepth -= 1;
    }
    if (token.key === ";" && triggerDepth === 0) {
      if (current.length) statements.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length) statements.push(current);
  return statements;
};

const schemaKeys = (tokens: SqlToken[]): string[] => {
  const keys = tokens.map(({ key }) => key);
  if (keys.at(-1) === ";") keys.pop();
  const index = keys[1] === "unique" || keys[1] === "virtual" ? 3 : 2;
  if (keys[0] === "create" && keys.slice(index, index + 3).join(" ") === "if not exists") {
    keys.splice(index, 3);
  }
  return keys;
};

const sameSchema = (left: string[], right: string[]): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const tableDefinitions = (keys: string[]): { definitions: string[][]; options: string[] } => {
  const start = keys.indexOf("(");
  if (start < 0) throw new Error("Cannot validate migration table definition.");
  const definitions: string[][] = [];
  let definition: string[] = [];
  let depth = 1;
  for (let index = start + 1; index < keys.length; index += 1) {
    const key = keys[index]!;
    if (key === "(") depth += 1;
    if (key === ")") depth -= 1;
    if (depth === 0) {
      definitions.push(definition);
      return { definitions, options: keys.slice(index + 1) };
    }
    if (key === "," && depth === 1) {
      definitions.push(definition);
      definition = [];
    } else definition.push(key);
  }
  throw new Error("Cannot validate incomplete migration table definition.");
};

// Adoption is statement-scoped, never inferred from a filename or another ledger row.
// Full column declarations retain CHECK/COLLATE/REFERENCES/generated constraints
// that table_info alone cannot verify. Equivalent but differently expressed SQL
// fails conservatively rather than silently accepting a different schema.
const alreadyAppliedDdl = async (
  store: Pick<BunSqliteStore, "prepare">,
  tokens: SqlToken[],
): Promise<boolean> => {
  const keys = schemaKeys(tokens);
  const alter = keys[0] === "alter" && keys[1] === "table" && keys[3] === "add";
  const create = keys[0] === "create";
  const kindIndex = keys[1] === "unique" || keys[1] === "virtual" ? 2 : 1;
  const kind = keys[kindIndex];
  if (!alter && (!create || !["table", "index", "trigger", "view"].includes(kind!))) return false;
  const identifier = alter ? keys[2]! : keys[kindIndex + 1]!;
  const name = /^["`\[]/.test(identifier)
    ? identifier.slice(1, -1).replaceAll('""', '"').replaceAll("``", "`")
    : identifier;
  const row = await store.prepare("SELECT type, sql FROM sqlite_schema WHERE name = ? COLLATE NOCASE")
    .bind(name).first<{ type: string; sql: string | null }>();
  if (!row) return false;
  const mismatch = () => new Error(`Migration schema mismatch for ${name}; refusing legacy adoption.`);
  if (!row.sql || row.type !== (alter ? "table" : kind)) throw mismatch();
  const actual = schemaKeys(tokenizeSql(row.sql));
  if (alter) {
    const expected = keys.slice(keys[4] === "column" ? 5 : 4);
    const column = tableDefinitions(actual).definitions.find((entry) => entry[0] === expected[0]);
    if (!column) return false;
    if (!sameSchema(column, expected)) throw mismatch();
    return true;
  }
  if (kind === "table" && keys[1] !== "virtual") {
    const expected = tableDefinitions(keys);
    const existing = tableDefinitions(actual);
    // Later ADD COLUMN migrations can legitimately extend a pre-ledger table.
    const constraint = (entry: string[]) => ["constraint", "primary", "unique", "check", "foreign"].includes(entry[0]!);
    if (!sameSchema(expected.options, existing.options) ||
      !expected.definitions.every((entry) => existing.definitions.some((candidate) => sameSchema(entry, candidate))) ||
      !existing.definitions.filter(constraint).every((entry) => expected.definitions.some((candidate) => sameSchema(entry, candidate)))) {
      throw mismatch();
    }
    return true;
  }
  if (!sameSchema(keys, actual)) throw mismatch();
  return true;
};

/** Applies pending SQL files atomically, adopting existing DDL only after exact schema validation. */
export const applySqliteMigrations = async (
  store: Pick<BunSqliteStore, "exec" | "prepare">,
  migrationsDir: string,
): Promise<string[]> => {
  const files = (await readdir(migrationsDir))
    .filter((entry) => entry.endsWith(".sql"))
    .sort();
  store.exec("CREATE TABLE IF NOT EXISTS nulldown_sqlite_migrations (name TEXT PRIMARY KEY)");
  const applied: string[] = [];
  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), "utf8");
    store.exec("BEGIN IMMEDIATE");
    try {
      const existing = await store.prepare(
        "SELECT name FROM nulldown_sqlite_migrations WHERE name = ?",
      ).bind(file).first();
      if (!existing) {
        for (const statement of migrationStatements(sql)) {
          if (["begin", "commit", "end", "rollback", "savepoint", "release", "attach", "detach"].includes(statement[0]!.key)) {
            throw new Error("Migration statements must not control the runner transaction.");
          }
          if (!(await alreadyAppliedDdl(store, statement))) {
            store.exec(sql.slice(statement[0]!.start, statement.at(-1)!.end));
          }
        }
        await store.prepare("INSERT INTO nulldown_sqlite_migrations (name) VALUES (?)")
          .bind(file).run();
        applied.push(file);
      }
      store.exec("COMMIT");
    } catch (error) {
      store.exec("ROLLBACK");
      throw error;
    }
  }
  return applied;
};

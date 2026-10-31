import { DatabaseSync } from "node:sqlite";
import {
  synchronousSqlResult,
  type BranchSqlPort,
  type BranchSqlValue,
} from "./sqlite-port";

/** Node SQLite connection lifetime; callers close it after all branch operations settle. Requires Node with node:sqlite. */
export class LocalBranchSqlite implements BranchSqlPort {
  private readonly database: DatabaseSync;

  constructor(filename = ":memory:") {
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = FULL");
  }

  /** Materializes a statement's rows while the synchronous connection is owned. */
  rows<T extends Record<string, unknown>>(
    sql: string,
    ...bindings: BranchSqlValue[]
  ): T[] {
    return this.database.prepare(sql).all(...bindings) as T[];
  }

  /** Executes a single parameterized mutation or schema statement. */
  execute(sql: string, ...bindings: BranchSqlValue[]): void {
    this.database.prepare(sql).run(...bindings);
  }

  /** Acquires write ownership before reading fences; rollback includes every publication row. */
  transaction<T>(body: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = synchronousSqlResult(body());
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /** Releases the local database; a newly opened connection rebuilds all authority from SQL. */
  close(): void {
    this.database.close();
  }
}

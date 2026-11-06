import {
  synchronousSqlResult,
  type BranchSqlPort,
  type BranchSqlValue,
} from "../../../src/server/state-plane/sqlite-port";

/** Adapts one SQLite DO storage lifetime to the synchronous portable SQL port. */
export class DurableObjectBranchSqlite implements BranchSqlPort {
  constructor(private readonly storage: DurableObjectStorage) {}
  /** Materializes SQL rows before the owning synchronous transaction exits. */
  rows<T extends Record<string, unknown>>(
    sql: string,
    ...bindings: BranchSqlValue[]
  ): T[] {
    return this.storage.sql.exec(sql, ...bindings).toArray() as T[];
  }
  /** Executes SQL without awaiting; exceptions remain inside transactionSync. */
  execute(sql: string, ...bindings: BranchSqlValue[]): void {
    this.storage.sql.exec(sql, ...bindings);
  }
  /** Rolls back all SQL mutations if any synchronous publication step throws. */
  transaction<T>(body: () => T): T {
    return this.storage.transactionSync(() => synchronousSqlResult(body()));
  }
}

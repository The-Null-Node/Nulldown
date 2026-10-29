/** Portable values used by the synchronous branch SQL boundary. */
export type BranchSqlValue = string | number | null;

/** One connection's synchronous SQL capabilities; transaction callbacks must never yield. */
export interface BranchSqlPort {
  rows<T extends Record<string, unknown>>(
    sql: string,
    ...bindings: BranchSqlValue[]
  ): T[];
  execute(sql: string, ...bindings: BranchSqlValue[]): void;
  transaction<T>(body: () => T): T;
}

/** Content-free instrumentation at the adapter boundary, also usable by independent fault-injection wrappers. */
export interface BranchSqlObservation {
  operation: "rows" | "execute" | "transaction";
  phase: "before" | "after";
  sql?: string;
}

/** Wraps one connection without changing transaction ownership or exposing an RPC failpoint. */
export function observeBranchSql(
  port: BranchSqlPort,
  observe: (event: BranchSqlObservation) => void,
): BranchSqlPort {
  return {
    rows<T extends Record<string, unknown>>(
      sql: string,
      ...bindings: BranchSqlValue[]
    ): T[] {
      observe({ operation: "rows", phase: "before", sql });
      const rows = port.rows<T>(sql, ...bindings);
      observe({ operation: "rows", phase: "after", sql });
      return rows;
    },
    execute(sql, ...bindings) {
      observe({ operation: "execute", phase: "before", sql });
      port.execute(sql, ...bindings);
      observe({ operation: "execute", phase: "after", sql });
    },
    transaction<T>(body: () => T): T {
      observe({ operation: "transaction", phase: "before" });
      const result = port.transaction(body);
      observe({ operation: "transaction", phase: "after" });
      return result;
    },
  };
}

/** Guards the synchronous transaction contract against accidental asynchronous callbacks. */
export function synchronousSqlResult<T>(result: T): T {
  if (
    result !== null &&
    (typeof result === "object" || typeof result === "function") &&
    "then" in result
  ) {
    throw new TypeError("SQL transaction callback must be synchronous");
  }
  return result;
}

import { createRequestLogger } from "../../core/logging/logger";
import type { SqlStatement } from "../../../../../src/server/ports";

/** Content-free timing record emitted during one resolved heap query. */
export interface ResolvedHeapTimingEvent {
  requestId: string;
  phase: string;
  phaseId: number;
  parentPhaseId?: number;
  outcome: "entry" | "complete" | "error" | "progress";
  /** Monotonic wall time since this request's observer was created. */
  elapsedMs: number;
  /** Inclusive phase wall time; nested phase durations must not be added to this. */
  durationMs: number;
  nodeCount?: number;
  /** Statement run attempts owned by this phase, excluding nested phases. */
  writesAttempted: number;
  /** Fulfilled statement runs, not affected-row counts; excludes nested phases. */
  writesCompleted: number;
  /** Sum of available D1 SQL execution durations; excludes network time. */
  sqlDurationMs: number;
  /** Completed writes with usable SQL duration metadata; zero means unmeasured. */
  sqlMetadataCount: number;
}

/** Optional request-local sink; failures and rejected promises never affect queries. */
export type ResolvedHeapTimingObserver = (
  event: ResolvedHeapTimingEvent,
) => void | Promise<void>;

/** Counters owned by one phase, never shared across requests or logged per node. */
export interface ResolvedHeapTimingSpan {
  /** Executes the original statement once and tracks completion without changing its result. */
  write(statement: SqlStatement): Promise<unknown>;
}

/** Request-lifetime phase observer used only by resolved heap services. */
export interface ResolvedHeapTiming {
  /** Measures a phase and preserves its exact return value or thrown error. */
  phase<T>(
    phase: string,
    operation: (span: ResolvedHeapTimingSpan) => Promise<T>,
    nodeCount?: number,
  ): Promise<T>;
}

const unobservedSpan: ResolvedHeapTimingSpan = {
  write: (statement) => statement.run(),
};

/** Measures an optional request-local phase; direct repository calls remain unobserved. */
export const timeHeapPhase = <T>(
  timing: ResolvedHeapTiming | undefined,
  phase: string,
  operation: (span: ResolvedHeapTimingSpan) => Promise<T>,
  nodeCount?: number,
): Promise<T> =>
  timing
    ? timing.phase(phase, operation, nodeCount)
    : operation(unobservedSpan);

/**
 * Creates a request-lifetime observer using the structured logger by default.
 * Query totals and generation phases emit at info; other phases require debug.
 * All phase errors emit at error without exception text. A supplied sink replaces
 * logging, receives every event, and is never awaited. Progress is capped at ten
 * records per phase, one per hundred completed writes. Phase nesting follows the
 * query's sequential execution; use a separate observer for independent requests.
 */
export const createResolvedHeapTiming = (
  request: Request,
  env: unknown,
  observer?: ResolvedHeapTimingObserver,
): ResolvedHeapTiming => {
  let requestId = "unavailable";
  let sink = observer;
  try {
    const logger = createRequestLogger({
      request,
      env,
      route: "resolved.heap.query",
    });
    requestId = logger.requestId;
    sink ??= (event) => {
      const level =
        event.outcome === "error"
          ? "error"
          : event.phase === "query" || event.phase.startsWith("projection.")
            ? "info"
            : "debug";
      logger[level]("resolved.heap.phase", { ...event });
    };
  } catch {
    // Logging setup is optional, just like delivery.
  }
  const startedAt = performance.now();
  let nextPhaseId = 0;
  const stack: number[] = [];
  const emit = (event: ResolvedHeapTimingEvent) => {
    try {
      const result = sink?.(event);
      if (result) void Promise.resolve(result).catch(() => undefined);
    } catch {
      // A telemetry sink must never alter query or persistence behavior.
    }
  };
  return {
    async phase(phase, operation, nodeCount) {
      const phaseId = ++nextPhaseId;
      const parentPhaseId = stack[stack.length - 1];
      const phaseStart = performance.now();
      let writesAttempted = 0;
      let writesCompleted = 0;
      let sqlDurationMs = 0;
      let sqlMetadataCount = 0;
      let progressEvents = 0;
      const report = (outcome: ResolvedHeapTimingEvent["outcome"]) => {
        const now = performance.now();
        emit({
          requestId,
          phase,
          phaseId,
          parentPhaseId,
          outcome,
          nodeCount,
          elapsedMs: now - startedAt,
          durationMs: now - phaseStart,
          writesAttempted,
          writesCompleted,
          sqlDurationMs,
          sqlMetadataCount,
        });
      };
      report("entry");
      stack.push(phaseId);
      try {
        const result = await operation({
          async write(statement) {
            writesAttempted += 1;
            const result = await statement.run();
            writesCompleted += 1;
            try {
              const meta = (
                result as {
                  meta?: {
                    duration?: number;
                    timings?: { sql_duration_ms?: number };
                  };
                } | null
              )?.meta;
              const duration = meta?.timings?.sql_duration_ms ?? meta?.duration;
              if (
                typeof duration === "number" &&
                Number.isFinite(duration) &&
                duration >= 0
              ) {
                sqlDurationMs += duration;
                sqlMetadataCount += 1;
              }
            } catch {
              // Adapter metadata is optional and cannot affect a successful write.
            }
            if (writesCompleted % 100 === 0 && progressEvents < 10) {
              progressEvents += 1;
              report("progress");
            }
            return result;
          },
        });
        report("complete");
        return result;
      } catch (error) {
        report("error");
        throw error;
      } finally {
        stack.pop();
      }
    },
  };
};

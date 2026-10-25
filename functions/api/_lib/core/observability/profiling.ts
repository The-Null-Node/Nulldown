import { sendTelemetryBatch, type TelemetryBinding } from "./transport";
import {
  MAX_BYTES,
  MAX_EVENTS,
  SUMMARY_BYTES,
  type PhaseSummary,
  validBatch,
  type Phase,
  type PhaseEvent,
} from "../../../../../shared/observability/profiling";

/** Portable request-owned observer, explicitly passed rather than globally scoped. */
export interface Timing {
  phase<T>(name: Phase, operation: (child: Timing) => Promise<T>): Promise<T>;
  sync<T>(name: Phase, operation: () => T): T;
}
/** No-op retains the original operation's result/rejection without telemetry work. */
export const unobserved: Timing = {
  phase: (_name, operation) => operation(unobserved),
  sync: (_name, operation) => operation(),
};
export interface TelemetryOptions {
  TELEMETRY?: TelemetryBinding;
  STAGING_TELEMETRY_ENABLED?: string;
  STAGING_TELEMETRY_ENVIRONMENT?: string;
  STAGING_PROFILING_MODE?: string;
  STAGING_PROFILING_SAMPLE_PERMILLE?: string;
}
function randomId(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
/** Strict W3C v00 carrier only. Duplicate headers combine with comma and are rejected. */
export function parent(request: Request): {
  traceId: string;
  parentSpanId?: string;
} {
  const raw = request.headers.get("traceparent") ?? "";
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(raw);
  return match && !/^0+$/.test(match[1]) && !/^0+$/.test(match[2])
    ? { traceId: match[1], parentSpanId: match[2] }
    : { traceId: randomId(16) };
}
/** Builds a bounded observer. finish schedules at most one batch, never awaits export. */
export function createTiming(
  request: Request,
  env: TelemetryOptions,
  waitUntil: ((task: Promise<unknown>) => void) | undefined,
  route: "request.content" | "request.diff",
) {
  const binding = env.TELEMETRY;
  const mode = env.STAGING_PROFILING_MODE;
  if (
    !binding ||
    env.STAGING_TELEMETRY_ENABLED !== "1" ||
    env.STAGING_TELEMETRY_ENVIRONMENT !== "staging" ||
    !waitUntil ||
    (mode !== undefined && !["summary", "detailed"].includes(mode))
  )
    return {
      timing: unobserved,
      finish: (status?: number) => {
        void status;
      },
    };
  const context = parent(request),
    rootId = randomId(8),
    start = performance.now();
  const events: PhaseEvent[] = [];
  const aggregates = new Map<Phase, PhaseSummary>();
  const profiled = mode !== undefined;
  const rawRate = env.STAGING_PROFILING_SAMPLE_PERMILLE ?? "1000";
  const rate =
    /^\d{1,4}$/.test(rawRate) && Number(rawRate) <= 1000 ? Number(rawRate) : 0;
  const sampled =
    mode === undefined ||
    (mode === "detailed" &&
      crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296 < rate / 1000);
  let numericTruncated = 0;
  const bounded = (n: number) => {
    if (!Number.isFinite(n) || n > Number.MAX_SAFE_INTEGER) {
      numericTruncated++;
      return Number.MAX_SAFE_INTEGER;
    }
    return Math.max(0, n);
  };
  function enter(name: Phase) {
    if (!profiled || finished) return undefined;
    let row = aggregates.get(name);
    if (!row) {
      row = {
        phase: name,
        count: 0,
        errors: 0,
        pending: 0,
        sumMs: 0,
        maxMs: 0,
      };
      aggregates.set(name, row);
    }
    row.count = bounded(row.count + 1);
    row.pending = bounded(row.pending + 1);
    return row;
  }
  function close(
    row: PhaseSummary | undefined,
    duration: number,
    error: boolean,
  ) {
    if (!row || finished) return;
    row.pending--;
    row.errors = bounded(row.errors + Number(error));
    row.sumMs = bounded(row.sumMs + duration);
    row.maxMs = bounded(Math.max(row.maxMs, duration));
  }
  const completed = new Set<PhaseEvent>();
  let dropped = 0,
    finished = false;
  // Reserve on entry, so capped children never reference a dropped parent.
  function reserve(name: Phase, parentSpanId: string): PhaseEvent | undefined {
    if (finished || !sampled) return;
    if (events.length >= MAX_EVENTS - 1) {
      dropped = profiled
        ? bounded(dropped + 1)
        : Math.min(1000000, dropped + 1);
      return;
    }
    const event: PhaseEvent = {
      traceId: context.traceId,
      spanId: randomId(8),
      parentSpanId,
      phase: name,
      outcome: "ok",
      offsetMs: performance.now() - start,
      durationMs: 0,
    };
    events.push(event);
    return event;
  }
  function scope(parentSpanId: string): Timing {
    return {
      async phase(name, operation) {
        const row = enter(name);
        const event = reserve(name, parentSpanId),
          at = performance.now();
        if (event) event.offsetMs = at - start;
        let outcome: "ok" | "error" = "ok";
        try {
          return await operation(
            event
              ? scope(event.spanId)
              : profiled
                ? scope(parentSpanId)
                : unobserved,
          );
        } catch (error) {
          outcome = "error";
          throw error;
        } finally {
          const duration = performance.now() - at;
          close(row, duration, outcome === "error");
          if (event) {
            event.outcome = outcome;
            event.durationMs = duration;
            completed.add(event);
          }
        }
      },
      sync(name, operation) {
        const row = enter(name);
        const event = reserve(name, parentSpanId),
          at = performance.now();
        if (event) event.offsetMs = at - start;
        let outcome: "ok" | "error" = "ok";
        try {
          return operation();
        } catch (error) {
          outcome = "error";
          throw error;
        } finally {
          const duration = performance.now() - at;
          close(row, duration, outcome === "error");
          if (event) {
            event.outcome = outcome;
            event.durationMs = duration;
            completed.add(event);
          }
        }
      },
    };
  }
  return {
    timing: scope(rootId),
    finish(status = 500) {
      if (finished) return;
      finished = true;
      // Background work is not a completed request phase. Exclude pending spans
      // and their descendants instead of reporting zero-duration successes.
      const closed = new Map(
        events
          .filter((event) => completed.has(event))
          .map((event) => [event.spanId, event]),
      );
      const hasClosedParents = (event: PhaseEvent): boolean => {
        let parent = event.parentSpanId;
        while (parent && parent !== rootId) {
          const ancestor = closed.get(parent);
          if (!ancestor) return false;
          parent = ancestor.parentSpanId;
        }
        return true;
      };
      const emitted = events.filter(
        (event) => completed.has(event) && hasClosedParents(event),
      );
      const truncated = events.length - emitted.length;
      dropped = profiled
        ? bounded(dropped + truncated)
        : Math.min(1000000, dropped + truncated);
      // Reserve the final slot for the root even when phase records hit the cap.
      const root = {
        ...context,
        spanId: rootId,
        phase: route,
        outcome: status >= 500 ? ("error" as const) : ("ok" as const),
        offsetMs: 0,
        durationMs: performance.now() - start,
        status,
        dropped: Math.min(1000000, dropped),
      };
      emitted.push(root);
      // Keep detail within its own byte allocation. Removing suffixes preserves
      // reserved ancestor order; root always retains the final slot.
      let byteTruncated = 0;
      if (profiled) {
        while (
          new TextEncoder().encode(JSON.stringify(emitted)).byteLength >
            MAX_BYTES - SUMMARY_BYTES - 512 &&
          emitted.length > 1
        ) {
          emitted.splice(emitted.length - 2, 1);
          byteTruncated++;
        }
        root.dropped = Math.min(1000000, dropped + byteTruncated);
      }
      const batch = profiled
        ? {
            version: 2,
            environment: "staging",
            events: emitted,
            summary: {
              traceId: context.traceId,
              spanId: rootId,
              mode,
              sampled,
              detailDropped: dropped - truncated,
              detailTruncated: truncated + byteTruncated,
              numericTruncated,
              phases: Array.from(aggregates.values()),
            },
          }
        : { version: 1, environment: "staging", events: emitted };
      if (!validBatch(batch)) return;
      const body = JSON.stringify(batch);
      if (new TextEncoder().encode(body).byteLength > MAX_BYTES) return;
      // Promise scheduling defers binding I/O until after the application's sync path.
      const task = Promise.resolve()
        .then(() => sendTelemetryBatch(binding, body, "phases"))
        .catch(() => undefined);
      try {
        waitUntil(task);
      } catch {
        /* Closed context: bounded best-effort task only. */
      }
    },
  };
}

/** Wraps only method calls, preserving receiver/arguments and returning the same data. */
export function observeStore<T extends object>(
  store: T,
  timing: Timing,
  kind: "r2" | "sql",
  originals = new WeakMap<object, object>(),
): T {
  if (timing === unobserved) return store;
  const proxy = new Proxy(store, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (kind === "sql" && (key === "prepare" || key === "bind"))
          return observeStore(
            Reflect.apply(value, target, args),
            timing,
            kind,
            originals,
          );
        if (kind === "sql" && key === "batch" && Array.isArray(args[0]))
          args[0] = args[0].map(
            (statement) => originals.get(statement) ?? statement,
          );
        const names: Record<string, Phase> =
          kind === "r2"
            ? {
                get: "r2.get",
                head: "r2.head",
                put: "r2.put",
                delete: "r2.delete",
                list: "r2.list",
              }
            : {
                all: "sql.read",
                first: "sql.read",
                raw: "sql.read",
                run: "sql.write",
                batch: "sql.write",
                exec: "sql.write",
              };
        const phase = names[String(key)];
        if (!phase) return Reflect.apply(value, target, args);
        return timing.phase(phase, async () => {
          const result = await Reflect.apply(value, target, args);
          if (kind === "r2" && key === "get" && result)
            return new Proxy(result, {
              get(object, property) {
                const member = Reflect.get(object, property, object);
                return ["text", "json", "arrayBuffer"].includes(
                  String(property),
                ) && typeof member === "function"
                  ? (...parameters: unknown[]) =>
                      timing.phase("r2.body", () =>
                        Promise.resolve(
                          Reflect.apply(member, object, parameters),
                        ),
                      )
                  : typeof member === "function"
                    ? member.bind(object)
                    : member;
              },
            });
          return result;
        });
      };
    },
  });
  originals.set(proxy, store);
  return proxy;
}

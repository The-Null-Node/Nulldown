/** Staging-only service-binding protocol. No caller-defined strings are accepted. */
export const PHASES = [
  "request.content",
  "request.diff",
  "content.target",
  "content.authority",
  "content.branch",
  "content.materialize",
  "content.serialize",
  "replay.direct",
  "replay.snapshot",
  "replay.checkpoint",
  "replay.events",
  "replay.apply",
  "diff.identity",
  "diff.body",
  "diff.auth",
  "diff.validate",
  "diff.branch",
  "diff.authority",
  "diff.append",
  "diff.serialize",
  "append.head",
  "append.upgrade",
  "append.content",
  "append.identities",
  "append.apply",
  "append.hash",
  "append.begin_commit",
  "append.events",
  "append.snapshot",
  "append.checkpoint",
  "append.fence_read",
  "append.publish",
  "append.markers",
  "append.dispatch",
  "lock.acquire",
  "lock.release",
  "r2.get",
  "r2.head",
  "r2.put",
  "r2.delete",
  "r2.list",
  "r2.body",
  "sql.read",
  "sql.write",
] as const;
export type Phase = (typeof PHASES)[number];
export const MAX_EVENTS = 96;
export const MAX_BYTES = 49152;
export const DEADLINE_MS = 500;
/** Finite content-free event; IDs are random tracing context, never resource IDs. */
export interface PhaseEvent {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  phase: Phase;
  outcome: "ok" | "error";
  offsetMs: number;
  durationMs: number;
  status?: number;
  dropped?: number;
}
/** Only this fixed schema/version/environment is accepted by the new collector. */
export interface Batch {
  version: 1;
  environment: "staging";
  events: PhaseEvent[];
}
/** Fixed-cardinality inclusive wall-clock aggregate, independent of detail retention. */
export interface PhaseSummary {
  phase: Phase;
  count: number;
  errors: number;
  pending: number;
  sumMs: number;
  maxMs: number;
}
/** Versioned summary protocol; legacy v1 remains accepted without reinterpretation. */
export interface ProfileBatch {
  version: 2;
  environment: "staging";
  events: PhaseEvent[];
  summary: {
    traceId: string;
    spanId: string;
    mode: "summary" | "detailed";
    sampled: boolean;
    detailDropped: number;
    detailTruncated: number;
    numericTruncated: number;
    phases: PhaseSummary[];
  };
}
export const SUMMARY_BYTES = 8192;
/** One nanosecond in millisecond units: floating reconstruction tolerance only.
 * Offsets/durations are <=24h; their IEEE754 addition error is below this bound.
 * This does not excuse clock drift, timer quantization or missing descendants. */
export const INTERVAL_EPSILON_MS = 0.000001;
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown, n: number) =>
  typeof v === "string" &&
  new RegExp(`^[0-9a-f]{${n}}$`).test(v) &&
  !/^0+$/.test(v);
const finite = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 86400000;
/** Rejects unknown properties instead of silently forwarding untrusted data. */
export function validBatch(value: unknown): value is Batch | ProfileBatch {
  if (object(value) && value.version === 2) {
    if (
      Object.keys(value).sort().join() !==
        "environment,events,summary,version" ||
      !validBatch({
        version: 1,
        environment: value.environment,
        events: value.events,
      }) ||
      !object(value.summary)
    )
      return false;
    const s = value.summary;
    const integer = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
    if (
      Object.keys(s).sort().join() !==
        "detailDropped,detailTruncated,mode,numericTruncated,phases,sampled,spanId,traceId" ||
      !id(s.traceId, 32) ||
      !id(s.spanId, 16) ||
      !["summary", "detailed"].includes(String(s.mode)) ||
      typeof s.sampled !== "boolean" ||
      ![s.detailDropped, s.detailTruncated, s.numericTruncated].every(
        integer,
      ) ||
      !Array.isArray(s.phases) ||
      s.phases.length > PHASES.length
    )
      return false;
    const seen = new Set<unknown>();
    for (const row of s.phases) {
      if (
        !object(row) ||
        Object.keys(row).sort().join() !==
          "count,errors,maxMs,pending,phase,sumMs" ||
        !PHASES.includes(row.phase as Phase) ||
        seen.has(row.phase) ||
        ![row.count, row.errors, row.pending].every(integer) ||
        Number(row.count) < 1 ||
        Number(row.errors) + Number(row.pending) > Number(row.count) ||
        ![row.sumMs, row.maxMs].every(
          (n) =>
            typeof n === "number" &&
            Number.isFinite(n) &&
            n >= 0 &&
            n <= Number.MAX_SAFE_INTEGER,
        )
      )
        return false;
      if (Number(row.maxMs) > Number(row.sumMs)) return false;
      seen.add(row.phase);
    }
    const root = (value.events as PhaseEvent[]).at(-1);
    if (
      !root ||
      root.dropped !==
        Math.min(
          1000000,
          Number(s.detailDropped) + Number(s.detailTruncated),
        ) ||
      root.status === undefined
    )
      return false;
    const parents = new Map<string, PhaseEvent>();
    const retained = new Map<
      Phase,
      { count: number; errors: number; sumMs: number; maxMs: number }
    >();
    for (const event of value.events as PhaseEvent[]) {
      if (parents.has(event.spanId)) return false;
      if (event !== root) {
        if (
          event.phase.startsWith("request.") ||
          event.status !== undefined ||
          event.dropped !== undefined
        )
          return false;
        const parent =
          event.parentSpanId === root.spanId
            ? root
            : parents.get(event.parentSpanId ?? "");
        if (
          !parent ||
          event.offsetMs < parent.offsetMs - INTERVAL_EPSILON_MS ||
          event.offsetMs + event.durationMs >
            parent.offsetMs + parent.durationMs + INTERVAL_EPSILON_MS
        )
          return false;
        const row = retained.get(event.phase) ?? {
          count: 0,
          errors: 0,
          sumMs: 0,
          maxMs: 0,
        };
        row.count++;
        row.errors += Number(event.outcome === "error");
        row.sumMs += event.durationMs;
        row.maxMs = Math.max(row.maxMs, event.durationMs);
        retained.set(event.phase, row);
      }
      parents.set(event.spanId, event);
    }
    const phases = s.phases as PhaseSummary[];
    if (phases.some((p) => p.phase.startsWith("request."))) return false; // Root is reserved, never an operation count.
    const detailed = s.mode === "detailed" && s.sampled === true;
    if (
      !detailed &&
      ((value.events as PhaseEvent[]).length !== 1 ||
        s.sampled !== false ||
        s.detailDropped !== 0 ||
        s.detailTruncated !== 0)
    )
      return false;
    let total = 0;
    for (const row of phases) {
      total += row.count;
      const r = retained.get(row.phase) ?? {
        count: 0,
        errors: 0,
        sumMs: 0,
        maxMs: 0,
      };
      if (
        r.count > row.count - row.pending ||
        r.errors > row.errors ||
        r.sumMs > row.sumMs + INTERVAL_EPSILON_MS * Math.max(1, r.count) ||
        r.maxMs > row.maxMs + INTERVAL_EPSILON_MS
      )
        return false;
      if (
        detailed &&
        s.numericTruncated === 0 &&
        s.detailDropped === 0 &&
        s.detailTruncated === 0 &&
        (row.pending !== 0 ||
          r.count !== row.count ||
          r.errors !== row.errors ||
          Math.abs(r.sumMs - row.sumMs) >
            INTERVAL_EPSILON_MS * Math.max(1, r.count) ||
          Math.abs(r.maxMs - row.maxMs) > INTERVAL_EPSILON_MS)
      )
        return false;
    }
    if (Array.from(retained.keys()).some((phase) => !seen.has(phase)))
      return false;
    if (
      detailed &&
      s.numericTruncated === 0 &&
      total - (value.events as PhaseEvent[]).length + 1 !==
        Number(s.detailDropped) + Number(s.detailTruncated)
    )
      return false;
    return (
      !!root &&
      root.traceId === s.traceId &&
      root.spanId === s.spanId &&
      root.offsetMs === 0 &&
      root.parentSpanId !== root.spanId &&
      !parents.has(root.parentSpanId ?? "") &&
      ["request.content", "request.diff"].includes(root.phase) &&
      (value.events as PhaseEvent[]).every((e) => e.traceId === s.traceId) &&
      new TextEncoder().encode(JSON.stringify(s)).byteLength <= SUMMARY_BYTES
    );
  }
  if (
    !object(value) ||
    Object.keys(value).sort().join() !== "environment,events,version" ||
    value.version !== 1 ||
    value.environment !== "staging" ||
    !Array.isArray(value.events) ||
    value.events.length < 1 ||
    value.events.length > MAX_EVENTS
  )
    return false;
  return value.events.every(
    (v) =>
      object(v) &&
      Object.keys(v).every((k) =>
        [
          "traceId",
          "spanId",
          "parentSpanId",
          "phase",
          "outcome",
          "offsetMs",
          "durationMs",
          "status",
          "dropped",
        ].includes(k),
      ) &&
      id(v.traceId, 32) &&
      id(v.spanId, 16) &&
      (v.parentSpanId === undefined || id(v.parentSpanId, 16)) &&
      PHASES.includes(v.phase as Phase) &&
      ["ok", "error"].includes(v.outcome as string) &&
      finite(v.offsetMs) &&
      finite(v.durationMs) &&
      (v.status === undefined ||
        (Number.isInteger(v.status) &&
          Number(v.status) >= 100 &&
          Number(v.status) <= 599)) &&
      (v.dropped === undefined ||
        (Number.isInteger(v.dropped) &&
          Number(v.dropped) >= 0 &&
          Number(v.dropped) <= 1000000)),
  );
}

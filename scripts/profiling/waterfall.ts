import type { ProfileBatch } from "../../shared/observability/profiling";
import { validBatch } from "../../shared/observability/profiling";
/** Bounded offline exclusive-wall calculation. Never infer exclusivity from missing detail. */
export function waterfall(batch: ProfileBatch) {
  const complete =
    validBatch(batch) &&
    batch.summary.mode === "detailed" &&
    batch.summary.sampled &&
    batch.summary.detailDropped === 0 &&
    batch.summary.detailTruncated === 0 &&
    batch.summary.numericTruncated === 0 &&
    batch.summary.phases.every((p) => p.pending === 0);
  const ids = new Set(batch.events.map((e) => e.spanId));
  const joined = batch.events.every(
    (e) =>
      e.spanId === batch.summary.spanId ||
      (!!e.parentSpanId && ids.has(e.parentSpanId)),
  );
  return batch.events.map((event) => {
    const children = batch.events
      .filter((e) => e.parentSpanId === event.spanId)
      .map((e) => [
        Math.max(event.offsetMs, e.offsetMs),
        Math.min(event.offsetMs + event.durationMs, e.offsetMs + e.durationMs),
      ])
      .filter(([a, b]) => b >= a)
      .sort(([a], [b]) => a - b);
    let union = 0,
      end = -Infinity;
    for (const [a, b] of children) {
      union += Math.max(0, b - Math.max(a, end));
      end = Math.max(end, b);
    }
    return {
      spanId: event.spanId,
      parentSpanId: event.parentSpanId,
      phase: event.phase,
      offsetMs: event.offsetMs,
      durationMs: event.durationMs,
      exclusiveMs:
        complete && joined ? Math.max(0, event.durationMs - union) : null,
      complete: complete && joined,
    };
  });
}

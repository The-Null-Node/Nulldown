import { test, expect } from "bun:test";
import {
  validBatch,
  INTERVAL_EPSILON_MS,
} from "../../../shared/observability/profiling";
import { waterfall } from "../waterfall";
function fixture() {
  const traceId = "1".repeat(32),
    spanId = "1".repeat(16);
  const event = (id: string, offsetMs: number, durationMs: number) => ({
    traceId,
    spanId: id.repeat(16),
    parentSpanId: spanId,
    phase: "r2.get",
    outcome: "ok",
    offsetMs,
    durationMs,
  });
  return {
    version: 2,
    environment: "staging",
    events: [
      event("2", 10, 20),
      event("3", 40, 30),
      {
        traceId,
        spanId,
        phase: "request.diff",
        outcome: "ok",
        offsetMs: 0,
        durationMs: 100,
        status: 200,
        dropped: 0,
      },
    ],
    summary: {
      traceId,
      spanId,
      mode: "detailed",
      sampled: true,
      detailDropped: 0,
      detailTruncated: 0,
      numericTruncated: 0,
      phases: [
        {
          phase: "r2.get",
          count: 2,
          errors: 0,
          pending: 0,
          sumMs: 50,
          maxMs: 30,
        },
      ],
    },
  };
}
test("consistent serial and parallel inclusive sums reconcile; root excluded", () => {
  const b = fixture();
  expect(validBatch(b)).toBe(true);
  expect(waterfall(b as any).at(-1)?.exclusiveMs).toBe(50);
  b.events[1].offsetMs = 20;
  expect(validBatch(b)).toBe(true);
  expect(waterfall(b as any).at(-1)?.exclusiveMs).toBe(60);
});
test("out of parent, missing/cyclic parent and unaccounted operation are not complete", () => {
  for (const mutate of [
    (b: any) => (b.events[0].offsetMs = 101),
    (b: any) => (b.events[0].offsetMs = -1),
    (b: any) => (b.events[0].parentSpanId = b.events[1].spanId),
    (b: any) => (b.events.at(-1).parentSpanId = b.events[0].spanId),
    (b: any) => (b.summary.phases[0].count = 3),
    (b: any) => (b.summary.phases[0].sumMs = 51),
    (b: any) => (b.summary.phases[0].errors = 1),
    (b: any) =>
      b.summary.phases.push({
        phase: "request.diff",
        count: 1,
        errors: 0,
        pending: 0,
        sumMs: 100,
        maxMs: 100,
      }),
  ]) {
    const b = fixture();
    mutate(b);
    expect(validBatch(b)).toBe(false);
    expect(waterfall(b as any).every((e) => e.complete)).toBe(false);
  }
});
test("floating epsilon only tolerates arithmetic roundoff, not clipped outliers", () => {
  const b = fixture();
  b.events[1].offsetMs = 70 + INTERVAL_EPSILON_MS / 2;
  expect(validBatch(b)).toBe(true);
  b.events[1].offsetMs = 70 + INTERVAL_EPSILON_MS * 2;
  expect(validBatch(b)).toBe(false);
});
test("legitimate pending, overflow, summary and unsampled evidence accepted but unknown", () => {
  for (const kind of ["pending", "overflow", "byte", "summary", "unsampled"]) {
    const b = fixture();
    b.events.splice(0, 1);
    if (kind === "pending") {
      b.summary.phases[0].pending = 1;
      b.summary.phases[0].sumMs = 30;
      b.summary.phases[0].maxMs = 30;
      b.summary.detailTruncated = 1;
    } else if (kind === "overflow") b.summary.detailDropped = 1;
    else if (kind === "byte") b.summary.detailTruncated = 1;
    else {
      b.events.splice(0, 1);
      b.summary.sampled = false;
      if (kind === "summary") b.summary.mode = "summary";
    }
    Object.assign(b.events.at(-1)!, {
      dropped: b.summary.detailDropped + b.summary.detailTruncated,
    });
    expect(validBatch(b)).toBe(true);
    expect(waterfall(b as any).every((e) => e.complete)).toBe(false);
  }
});
test("mode and loss counters cannot conceal contradictory detail", () => {
  for (const mutate of [
    (b: any) => (b.summary.mode = "summary"),
    (b: any) => (b.summary.sampled = false),
    (b: any) => {
      b.summary.detailDropped = 1;
      b.events.at(-1).dropped = 1;
    },
    (b: any) => (b.summary.phases[0].pending = 1),
  ]) {
    const b = fixture();
    mutate(b);
    expect(validBatch(b)).toBe(false);
  }
});

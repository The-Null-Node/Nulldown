import { test, expect } from "bun:test";
import {
  createTiming,
  observeStore,
  unobserved,
} from "../../../functions/api/_lib/core/observability/profiling";
import { validBatch, MAX_BYTES } from "../../../shared/observability/profiling";
import { waterfall } from "../waterfall";

function harness(mode: string | undefined, rate = "1000", enabled = "1") {
  const tasks: Promise<unknown>[] = [],
    batches: any[] = [];
  const session = createTiming(
    new Request("https://local.invalid/CANARY", {
      headers: {
        traceparent: "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01",
      },
    }),
    {
      STAGING_TELEMETRY_ENABLED: enabled,
      STAGING_TELEMETRY_ENVIRONMENT: "staging",
      STAGING_PROFILING_MODE: mode,
      STAGING_PROFILING_SAMPLE_PERMILLE: rate,
      TELEMETRY: {
        async fetch(r) {
          batches.push(JSON.parse(await r.text()));
          return new Response(null, { status: 204 });
        },
      },
    },
    (task) => tasks.push(task),
    "request.diff",
  );
  return { ...session, batches, tasks, flush: () => Promise.all(tasks) };
}
test("summary retains nested operations after 96 details, errors and counts exact", async () => {
  for (const mode of ["summary", "detailed"]) {
    const h = harness(mode);
    for (let i = 0; i < 150; i++)
      await h.timing.phase("append.events", async (child) => {
        await child.phase("r2.put", async () => 1);
        child.sync("append.hash", () => 1);
      });
    await expect(
      h.timing.phase("r2.get", async () => {
        throw Error("CANARY");
      }),
    ).rejects.toThrow();
    h.finish(200);
    await h.flush();
    const b = h.batches[0];
    expect(validBatch(b)).toBe(true);
    expect(b.version).toBe(2);
    expect(b.summary.phases.find((p: any) => p.phase === "r2.put").count).toBe(
      150,
    );
    expect(
      b.summary.phases.find((p: any) => p.phase === "append.hash").count,
    ).toBe(150);
    expect(b.summary.phases.find((p: any) => p.phase === "r2.get").errors).toBe(
      1,
    );
    expect(b.events.length).toBe(mode === "summary" ? 1 : 96);
    expect(b.summary.detailDropped).toBe(mode === "summary" ? 0 : 356);
    expect(b.summary.detailTruncated).toBe(0);
    expect(JSON.stringify(b)).not.toContain("CANARY");
    expect(new TextEncoder().encode(JSON.stringify(b)).length).toBeLessThan(
      MAX_BYTES,
    );
  }
});
test("off, invalid and unset gate retain identity; headers do not enable", () => {
  for (const [mode, gate] of [
    ["off", "1"],
    ["invalid", "1"],
    ["summary", "0"],
    [undefined, "0"],
  ]) {
    const h = harness(mode, "1000", gate);
    expect(h.timing).toBe(unobserved);
    const store = { get: async () => 1 };
    expect(observeStore(store, h.timing, "r2")).toBe(store);
    h.finish();
    expect(h.tasks.length).toBe(0);
  }
});
test("legacy v1 stays compatible; zero/invalid sampling still summarizes", async () => {
  for (const [mode, rate] of [
    [undefined, "1000"],
    ["detailed", "0"],
    ["detailed", "invalid"],
  ]) {
    const h = harness(mode, rate);
    h.timing.sync("append.hash", () => 1);
    h.finish(200);
    await h.flush();
    const b = h.batches[0];
    expect(validBatch(b)).toBe(true);
    if (mode === undefined) expect(b.version).toBe(1);
    else {
      expect(b.events.length).toBe(1);
      expect(b.summary.sampled).toBe(false);
      expect(b.summary.phases[0].count).toBe(1);
    }
  }
});
test("pending summary frozen and truncated details explicit after finish", async () => {
  const h = harness("detailed");
  let release!: () => void;
  const pending = h.timing.phase(
    "r2.get",
    () => new Promise<void>((r) => (release = r)),
  );
  h.finish(200);
  await h.flush();
  release();
  await pending;
  const b = h.batches[0];
  expect(b.summary.phases[0].pending).toBe(1);
  expect(b.summary.detailTruncated).toBe(1);
});
test("v2 consumer rejects unsafe fields, duplicate phases and mismatched roots", async () => {
  const h = harness("summary");
  h.timing.sync("append.hash", () => 1);
  h.finish(200);
  await h.flush();
  for (const change of [
    (b: any) => (b.summary.path = "CANARY"),
    (b: any) => b.summary.phases.push(b.summary.phases[0]),
    (b: any) => (b.summary.spanId = "1111111111111111"),
    (b: any) => (b.summary.detailDropped = -1),
  ]) {
    const b = structuredClone(h.batches[0]);
    change(b);
    expect(validBatch(b)).toBe(false);
  }
});
test("waterfall unions overlapping direct children and refuses incomplete exclusivity", async () => {
  const h = harness("detailed");
  h.finish(200);
  await h.flush();
  const b = h.batches[0];
  const root = b.events[0];
  root.durationMs = 100;
  b.events.unshift(
    {
      ...root,
      spanId: "1111111111111111",
      parentSpanId: root.spanId,
      phase: "r2.get",
      offsetMs: 10,
      durationMs: 30,
    },
    {
      ...root,
      spanId: "2222222222222222",
      parentSpanId: root.spanId,
      phase: "r2.get",
      offsetMs: 20,
      durationMs: 40,
    },
  );
  b.events[0].dropped = undefined;
  b.events[0].status = undefined;
  b.events[1].dropped = undefined;
  b.events[1].status = undefined;
  b.summary.phases = [
    { phase: "r2.get", count: 2, errors: 0, pending: 0, sumMs: 70, maxMs: 40 },
  ];
  expect(waterfall(b).at(-1)?.exclusiveMs).toBe(50);
  b.summary.detailDropped = 1;
  expect(waterfall(b).at(-1)?.exclusiveMs).toBe(null);
});

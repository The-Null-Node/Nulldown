import { test, expect, spyOn } from "bun:test";
import { collectPhaseBatch } from "../../../functions/api/_lib/core/observability/ingestion";
const collector = { fetch: collectPhaseBatch };
import {
  createTiming,
  observeStore,
  parent,
  unobserved,
} from "../../../functions/api/_lib/core/observability/profiling";
import {
  validBatch,
  MAX_EVENTS,
  MAX_BYTES,
} from "../../../shared/observability/profiling";
import { appendEventsToBranch } from "../../../functions/api/_lib/nulledit/service";
import { getBranchContent } from "../../../functions/api/_lib/branches/http/read";
import {
  createSeededBucket,
  rootDropId,
  makeEvent,
  accountId,
} from "../../../functions/api/_lib/diffs/testing/storage-fixture";
import { resolveBranchForActor } from "../../../functions/api/_lib/branches/lifecycle";
import { createBranchRepository } from "../../../functions/api/_lib/branches/storage/repository";

const trace = "1234567890abcdef1234567890abcdef",
  span = "1234567890abcdef";
const request = () =>
  new Request("https://example.invalid/private/root?secret=CANARY", {
    headers: {
      traceparent: `00-${trace}-${span}-01`,
      baggage: "CANARY",
      authorization: "Bearer CANARY",
      "x-request-id": "CANARY",
    },
  });
function harness(fetcher?: (r: Request) => Promise<Response>) {
  const tasks: Promise<unknown>[] = [],
    bodies: string[] = [];
  const session = createTiming(
    request(),
    {
      STAGING_TELEMETRY_ENABLED: "1",
      STAGING_TELEMETRY_ENVIRONMENT: "staging",
      TELEMETRY: {
        fetch:
          fetcher ??
          (async (r) => {
            bodies.push(await r.text());
            return new Response(null, { status: 204 });
          }),
      },
    },
    (task) => tasks.push(task),
    "request.diff",
  );
  return { ...session, tasks, bodies, flush: () => Promise.all(tasks) };
}
const event = () => ({
  traceId: trace,
  spanId: span,
  phase: "request.diff",
  outcome: "ok",
  offsetMs: 0,
  durationMs: 1,
});
const batch = () => ({ version: 1, environment: "staging", events: [event()] });
const ingestion = (
  body: string | ReadableStream<Uint8Array>,
  headers?: Record<string, string>,
) =>
  new Request("https://staging-telemetry.internal/v1/phases", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  });

test("disabled is no-op and does not call waitUntil or binding", async () => {
  let touched = false;
  const s = createTiming(
    request(),
    {
      TELEMETRY: {
        fetch: async () => {
          touched = true;
          throw Error();
        },
      },
    },
    () => {
      touched = true;
    },
    "request.diff",
  );
  expect(s.timing).toBe(unobserved);
  expect(await s.timing.phase("diff.auth", async () => 7)).toBe(7);
  s.finish(202);
  expect(touched).toBe(false);
});
test("binding absent or logical environment wrong disables", () => {
  for (const env of [
    { STAGING_TELEMETRY_ENABLED: "1" },
    {
      STAGING_TELEMETRY_ENABLED: "1",
      STAGING_TELEMETRY_ENVIRONMENT: "production",
    },
  ])
    expect(createTiming(request(), env, () => {}, "request.diff").timing).toBe(
      unobserved,
    );
});
test("strict traceparent rejects duplicates, zero IDs, unknown version and whitespace", () => {
  expect(parent(request()).traceId).toBe(trace);
  for (const value of [
    `00-${trace}-${span}-01,00-${trace}-${span}-01`,
    `00-${"0".repeat(32)}-${span}-01`,
    `ff-${trace}-${span}-01`,
    `00-${trace}-${"0".repeat(16)}-01`,
  ])
    expect(
      parent(
        new Request("https://example.invalid", {
          headers: { traceparent: value },
        }),
      ).traceId,
    ).not.toBe(trace);
});
test("nested and concurrent phase contexts are explicit and do not cross", async () => {
  const h = harness();
  await Promise.all(
    ["diff.auth", "diff.branch"].map((name) =>
      h.timing.phase(name as "diff.auth", async (child) => {
        await Bun.sleep(1);
        await child.phase("r2.get", async () => 1);
      }),
    ),
  );
  h.finish(200);
  await h.flush();
  const events = JSON.parse(h.bodies[0]).events;
  for (const top of events.filter(
    (e: { phase: string }) =>
      e.phase === "diff.auth" || e.phase === "diff.branch",
  ))
    expect(
      events.filter(
        (e: { parentSpanId: string }) => e.parentSpanId === top.spanId,
      ),
    ).toHaveLength(1);
  const second = harness();
  await second.timing.phase("diff.body", async () => 1);
  second.finish(200);
  await second.flush();
  expect(JSON.parse(second.bodies[0]).events.at(-1).spanId).not.toBe(
    events.at(-1).spanId,
  );
});
test("pending background phases are not exported as completed successes", async () => {
  const h = harness();
  let release!: () => void;
  const pending = h.timing.phase("append.dispatch", async (child) => {
    await child.phase("r2.get", async () => 1);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await Bun.sleep(1);
  h.finish(200);
  await h.flush();
  const events = JSON.parse(h.bodies[0]).events;
  expect(events).toHaveLength(1);
  expect(events[0].dropped).toBe(2);
  release();
  await pending;
});

test("payload has no paths, headers, IDs, content or exception text", async () => {
  const h = harness();
  const error = new Error("CANARY private prompt");
  await expect(
    h.timing.phase("diff.auth", async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  h.finish(500);
  await h.flush();
  expect(h.bodies[0]).not.toContain("CANARY");
  expect(validBatch(JSON.parse(h.bodies[0]))).toBe(true);
});
test("export is not on canonical critical path, synchronous/rejected failures isolated", async () => {
  for (const fetcher of [
    () => {
      throw new Error("CANARY");
    },
    async () => {
      throw new Error("CANARY");
    },
  ]) {
    const h = harness(fetcher);
    expect(await h.timing.phase("diff.body", async () => "accepted")).toBe(
      "accepted",
    );
    h.finish(202);
    await h.flush();
  }
  let release!: () => void;
  const h = harness(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return new Response();
  });
  h.finish(202);
  await Bun.sleep(1);
  expect(h.tasks).toHaveLength(1);
  release();
  await h.flush();
});
test("non-cooperative exporter resolves at bounded deadline and gets abort signal", async () => {
  let signal: AbortSignal | undefined;
  const h = harness(async (r) => {
    signal = r.signal;
    return new Promise(() => {});
  });
  const start = performance.now();
  h.finish(202);
  await h.flush();
  expect(performance.now() - start).toBeLessThan(1500);
  expect(signal?.aborted).toBe(true);
});
test("event/byte caps preserve root and never leave missing local parents", async () => {
  const h = harness();
  for (let i = 0; i < 200; i++)
    await h.timing.phase("diff.body", async (child) =>
      child.phase("r2.get", async () => 1),
    );
  h.finish(200);
  h.finish(200);
  await h.flush();
  expect(h.bodies).toHaveLength(1);
  expect(new TextEncoder().encode(h.bodies[0]).length).toBeLessThanOrEqual(
    MAX_BYTES,
  );
  const b = JSON.parse(h.bodies[0]);
  expect(b.events).toHaveLength(MAX_EVENTS);
  const root = b.events.at(-1);
  expect(root.dropped).toBeGreaterThan(0);
  const ids = new Set(b.events.map((e: { spanId: string }) => e.spanId));
  for (const e of b.events.slice(0, -1))
    expect(ids.has(e.parentSpanId)).toBe(true);
});
test("collector logs only validated batch, rejects extra data and nonfinite/out-of-range values", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(
      (await collector.fetch(ingestion(JSON.stringify(batch())))).status,
    ).toBe(204);
    expect(log).toHaveBeenCalledTimes(1);
    for (const invalid of [
      { ...batch(), auth: "CANARY" },
      { ...batch(), environment: "production" },
      { ...batch(), events: [{ ...event(), body: "CANARY" }] },
      { ...batch(), events: [{ ...event(), durationMs: -1 }] },
      { ...batch(), events: [{ ...event(), status: 999 }] },
      { ...batch(), events: Array(97).fill(event()) },
    ])
      expect(
        (await collector.fetch(ingestion(JSON.stringify(invalid)))).status,
      ).toBe(400);
    expect(log).toHaveBeenCalledTimes(1);
  } finally {
    log.mockRestore();
  }
});
test("collector enforces real streamed byte cap, length cap and fixed route/method", async () => {
  expect(
    (
      await collector.fetch(
        ingestion("{}", { "content-length": String(MAX_BYTES + 1) }),
      )
    ).status,
  ).toBe(413);
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(MAX_BYTES + 1));
    },
    cancel() {
      canceled = true;
    },
  });
  expect((await collector.fetch(ingestion(stream))).status).toBe(400);
  expect(canceled).toBe(true);
  expect(
    (
      await collector.fetch(
        new Request("https://staging-telemetry.internal/v1/phases"),
      )
    ).status,
  ).toBe(404);
  expect(
    (await collector.fetch(new Request("https://example.invalid/secret")))
      .status,
  ).toBe(404);
});
test("collector bounds empty-chunk reads as well as bytes", async () => {
  let reads = 0,
    canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads++;
      controller.enqueue(new Uint8Array());
    },
    cancel() {
      canceled = true;
    },
  });
  expect((await collector.fetch(ingestion(stream))).status).toBe(400);
  expect(reads).toBeLessThanOrEqual(257);
  expect(canceled).toBe(true);
});

test("collector stalled stream canceled at bounded deadline", async () => {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      canceled = true;
    },
  });
  expect((await collector.fetch(ingestion(stream))).status).toBe(400);
  expect(canceled).toBe(true);
});
test("store wrapper retains receiver, conditionals and thrown identity", async () => {
  const h = harness(),
    condition = { onlyIf: { etagMatches: "CANARY" } },
    error = new Error("CANARY");
  const store = {
    value: 9,
    async put(key: string, body: string, options: unknown) {
      expect(this).toBe(store);
      expect(key).toBe("CANARY");
      expect(options).toBe(condition);
      return this.value;
    },
    async get() {
      throw error;
    },
  };
  const observed = observeStore(store, h.timing, "r2");
  expect(await observed.put("CANARY", "CANARY", condition)).toBe(9);
  await expect(observed.get()).rejects.toBe(error);
  h.finish(200);
  await h.flush();
  expect(h.bodies[0]).not.toContain("CANARY");
});
test("SQL batch unwraps native prepared statements", async () => {
  const h = harness();
  const statement = {
    bind() {
      return this;
    },
    async run() {
      return 1;
    },
  };
  const db = {
    prepare() {
      return statement;
    },
    async batch(statements: object[]) {
      expect(statements[0]).toBe(statement);
      return [1];
    },
  };
  const proxy = observeStore(db, h.timing, "sql");
  expect(await proxy.batch([proxy.prepare().bind()])).toEqual([1]);
  h.finish(200);
  await h.flush();
});
test("real append/read/replay uses same storage calls/conditionals with tracing enabled", async () => {
  async function run(enabled: boolean, exportFails = false) {
    const bucket = createSeededBucket(),
      calls: string[] = [];
    const recording = new Proxy(bucket, {
      get(target, key) {
        const v = Reflect.get(target, key, target);
        return typeof v === "function"
          ? (...args: unknown[]) => {
              if (
                ["get", "put", "delete", "list", "head"].includes(String(key))
              )
                calls.push(
                  `${String(key)}:${String(args[0])}:${JSON.stringify((args[2] as { onlyIf?: unknown })?.onlyIf ?? null)}`,
                );
              return Reflect.apply(v, target, args);
            }
          : v;
      },
    });
    const h = harness(
        exportFails
          ? async () => {
              throw new Error("synthetic-export-failure");
            }
          : undefined,
      ),
      timing = enabled ? h.timing : unobserved;
    const store = observeStore(recording, timing, "r2");
    await resolveBranchForActor(store, rootDropId, accountId, "fixture");
    calls.length = 0;
    const repo = createBranchRepository({ blobs: store });
    const branch = await repo.readBranch(rootDropId, "owner");
    expect(branch).not.toBeNull();
    const event = makeEvent({
      eventId: "telemetry-fixture-event",
      sourceClientId: "fixture",
      text: "test",
      createdAt: 1,
    });
    const result = await appendEventsToBranch(
      store,
      branch!,
      [event],
      undefined,
      undefined,
      timing,
    );
    const duplicate = await appendEventsToBranch(
      store,
      result.branch,
      [event],
      undefined,
      undefined,
      timing,
    );
    const response = await getBranchContent(
      { R2_BUCKET: store },
      { rootId: rootDropId, branchId: "owner" },
      new Request("https://example.invalid"),
      timing,
    );
    h.finish(response.status);
    await h.flush();
    // ETags/created timestamps vary between fixtures; compare operation/key/conditional shape.
    return {
      calls: calls.map((c) =>
        c.replace(/"etagMatches":"[^"]+"/g, '"etagMatches":"ETAG"'),
      ),
      accepted: result.acceptedEvents.length,
      duplicate: duplicate.deduplicatedCount,
      content: result.content,
      response: await response.json(),
      bodies: h.bodies,
    };
  }
  const off = await run(false),
    on = await run(true);
  expect(on.calls).toEqual(off.calls);
  expect(on.content).toBe(off.content);
  expect(on.accepted).toBe(1);
  expect(on.duplicate).toBe(1);
  expect(on.response).toEqual(off.response);
  expect(on.bodies).toHaveLength(1);
  const names = JSON.parse(on.bodies[0]).events.map(
    (e: { phase: string }) => e.phase,
  );
  expect(names).toContain("lock.acquire");
  expect(names).toContain("append.publish");
  expect(names).toContain("append.begin_commit");
  const failedExport = await run(true, true);
  expect(failedExport.calls).toEqual(off.calls);
  expect(failedExport.response).toEqual(off.response);
  expect(failedExport.accepted).toBe(1);
  expect(failedExport.duplicate).toBe(1);
});

test("real stale predecessor rejection leaves canonical head unchanged", async () => {
  const bucket = createSeededBucket(),
    h = harness();
  const store = observeStore(bucket, h.timing, "r2");
  const { branch } = await resolveBranchForActor(
    store,
    rootDropId,
    accountId,
    "fixture",
  );
  const repository = createBranchRepository({ blobs: store });
  const before = await repository.readBranch(rootDropId, branch.branchId);
  const event = makeEvent({
    eventId: "stale-fixture",
    sourceClientId: "fixture",
    text: "CANARY",
    createdAt: 1,
    metadata: { followsSeq: 999 },
  });
  await expect(
    appendEventsToBranch(
      store,
      branch,
      [event],
      undefined,
      undefined,
      h.timing,
    ),
  ).rejects.toThrow("diff_predecessor_mismatch");
  expect(await repository.readBranch(rootDropId, branch.branchId)).toEqual(
    before,
  );
  h.finish(409);
  await h.flush();
  expect(h.bodies[0]).not.toContain("CANARY");
  expect(
    JSON.parse(h.bodies[0]).events.some(
      (e: { phase: string }) => e.phase === "append.publish",
    ),
  ).toBe(false);
});

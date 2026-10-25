import { expect, test } from "bun:test";
import { createTiming } from "../../../functions/api/_lib/core/observability/profiling";
import { validBatch } from "../../../shared/observability/profiling";
import { waterfall } from "../waterfall";

async function batch() {
  const tasks: Promise<unknown>[] = [];
  const batches: any[] = [];
  const session = createTiming(
    new Request("https://local.invalid/"),
    {
      STAGING_TELEMETRY_ENABLED: "1",
      STAGING_TELEMETRY_ENVIRONMENT: "staging",
      STAGING_PROFILING_MODE: "detailed",
      TELEMETRY: {
        async fetch(request) {
          batches.push(await request.json());
          return new Response(null, { status: 204 });
        },
      },
    },
    (task) => tasks.push(task),
    "request.diff",
  );
  session.timing.sync("append.hash", () => 1);
  session.finish(200);
  await Promise.all(tasks);
  return batches[0];
}

test("inconsistent summary/detail count must not certify complete exclusive time", async () => {
  const value = await batch();
  value.summary.phases[0].count = 2; // One retained event, no reported loss or pending work.
  expect(
    validBatch(value) &&
      value.version === 2 &&
      waterfall(value).every((row) => row.complete),
  ).toBe(false);
});

test("child outside its parent interval must not certify complete exclusive time", async () => {
  const value = await batch();
  const root = value.events.at(-1);
  value.events[0].offsetMs = root.durationMs + 100;
  value.events[0].durationMs = 50;
  expect(
    validBatch(value) &&
      value.version === 2 &&
      waterfall(value).every((row) => row.complete),
  ).toBe(false);
});

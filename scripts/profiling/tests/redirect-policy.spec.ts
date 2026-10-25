import { test, expect } from "bun:test";
import { createTiming } from "../../../functions/api/_lib/core/observability/profiling";

test("all export requests use manual and non204 acknowledgements fail open", async () => {
  for (const status of [204, 200, 302, 400, 500]) {
    const tasks: Promise<unknown>[] = [];
    let calls = 0,
      canceled = false;
    const session = createTiming(
      new Request("https://fixture.invalid"),
      {
        STAGING_TELEMETRY_ENABLED: "1",
        STAGING_TELEMETRY_ENVIRONMENT: "staging",
        TELEMETRY: {
          async fetch(request) {
            calls++;
            expect(request.redirect).toBe("manual");
            expect(request.url).toBe(
              "https://staging-telemetry.internal/v1/phases",
            );
            const body =
              status === 204
                ? null
                : new ReadableStream({
                    cancel() {
                      canceled = true;
                    },
                  });
            return new Response(body, {
              status,
              headers:
                status === 302
                  ? { Location: "https://never-follow.invalid" }
                  : {},
            });
          },
        },
      },
      (task) => tasks.push(task),
      "request.content",
    );
    const canonical = await session.timing.phase(
      "content.target",
      async () => "unchanged",
    );
    session.finish(404);
    await Promise.all(tasks);
    expect(canonical).toBe("unchanged");
    expect(calls).toBe(1);
    if (status !== 204) expect(canceled).toBe(true);
  }
});

test("strict acknowledgement guard never changes a rejected canonical operation", async () => {
  const original = new Error("synthetic canonical failure");
  const tasks: Promise<unknown>[] = [];
  const session = createTiming(
    new Request("https://fixture.invalid"),
    {
      STAGING_TELEMETRY_ENABLED: "1",
      STAGING_TELEMETRY_ENVIRONMENT: "staging",
      TELEMETRY: {
        async fetch() {
          return new Response(null, { status: 503 });
        },
      },
    },
    (task) => tasks.push(task),
    "request.content",
  );
  await expect(
    session.timing.phase("content.authority", async () => {
      throw original;
    }),
  ).rejects.toBe(original);
  session.finish(500);
  await expect(Promise.all(tasks)).resolves.toEqual([undefined]);
});

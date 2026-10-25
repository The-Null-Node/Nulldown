import { expect, test, spyOn } from "bun:test";
import { sendTelemetryBatch } from "../../../functions/api/_lib/core/observability/transport";
import { backgroundKind, exportsWithinDeadline } from "../background";
test("fixture distinguishes snapshotter lifetime from bounded telemetry without relaxing export limit", () => {
  const stack = (caller: string) =>
    `Error\n    at Proxy.<anonymous> (fixture:1)\n    at ${caller} (compiled:1)`;
  expect(backgroundKind(stack("Object.finish"))).toBe("profile-export");
  expect(backgroundKind(stack("scheduleBufferedCommitFlush"))).toBe(
    "snapshotter",
  );
  expect(backgroundKind(stack("onRequest"))).toBe("legacy-export");
  expect(backgroundKind(stack("unknown"))).toBe("other");
  const tasks = [
    { kind: "snapshotter", ms: 900 },
    { kind: "profile-export", ms: 500 },
    { kind: "legacy-export", ms: 3 },
  ];
  expect(tasks.every((t) => t.ms <= 650)).toBe(false); // Deterministic reproduction of the old scope error.
  expect(exportsWithinDeadline(tasks)).toBe(true);
  expect(
    exportsWithinDeadline([...tasks, { kind: "profile-export", ms: 651 }]),
  ).toBe(false);
  expect(
    exportsWithinDeadline([...tasks, { kind: "legacy-export", ms: 651 }]),
  ).toBe(false);
});
test("deadline before collector readiness deterministically loses batch, aborts once, never retries or reports acceptance", async () => {
  let fire: () => void = () => {};
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    ms: number,
  ) => {
    expect(ms).toBe(500);
    fire = callback;
    return 1;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
  let attempts = 0,
    accepted = 0,
    aborted = 0;
  let request: Request | undefined;
  let ready: () => void = () => {};
  try {
    const task = sendTelemetryBatch(
      {
        fetch: async (r) => {
          attempts++;
          request = r;
          r.signal.addEventListener("abort", () => {
            aborted++;
          });
          await new Promise<void>((resolve) => {
            ready = resolve;
          });
          if (!r.signal.aborted) accepted++;
          return new Response(null, { status: 204 });
        },
      },
      "{}",
      "phases",
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(attempts).toBe(1);
    expect(request!.redirect).toBe("manual");
    fire();
    await task;
    expect(request!.signal.aborted).toBe(true);
    expect(aborted).toBe(1);
    expect(accepted).toBe(0);
    ready();
    await Promise.resolve();
    await Promise.resolve();
    expect(accepted).toBe(0);
    expect(attempts).toBe(1);
  } finally {
    ready();
    timer.mockRestore();
    clear.mockRestore();
  }
});

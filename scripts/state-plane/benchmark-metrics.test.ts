import {
  collectBenchmarkSamples,
  summarizeBenchmarkSamples,
} from "./benchmark-metrics";

describe("controlled benchmark metrics", () => {
  it("excludes warmups, retains failures, and records output hashes", async () => {
    const samples = await collectBenchmarkSamples({
      operation: "query",
      arm: "legacy",
      iterations: 3,
      warmups: 1,
      timeoutMs: 100,
      run: async (iteration) => {
        if (iteration === 1)
          throw Object.assign(new Error("fixture"), {
            code: "fixture_failure",
          });
        return { iteration };
      },
      hash: ({ iteration }) => String(iteration),
    });
    expect(samples).toHaveLength(3);
    expect(samples.map((sample) => sample.iteration)).toEqual([0, 1, 2]);
    expect(samples[0]).toMatchObject({ ok: true, outputHash: "0" });
    expect(samples[1]).toMatchObject({
      ok: false,
      errorCode: "fixture_failure",
    });
    expect(summarizeBenchmarkSamples(samples)).toMatchObject({
      count: 3,
      successCount: 2,
      failureCount: 1,
      failureRate: 1 / 3,
    });
  });

  it("summarizes nearest-rank quantiles and throughput", () => {
    const summary = summarizeBenchmarkSamples(
      [1, 2, 3, 4, 5].map((latencyMs, iteration) => ({
        operation: "read",
        arm: "state-plane" as const,
        iteration,
        latencyMs,
        ok: true,
      })),
    );
    expect(summary).toMatchObject({ p50Ms: 3, p95Ms: 5, p99Ms: 5 });
    expect(summary.throughputPerSecond).toBeCloseTo(1000 / 3);
  });

  it("aborts a timed-out request and never overlaps attempts on one lane", async () => {
    let active = 0;
    let maxActive = 0;
    let aborts = 0;
    const samples = await collectBenchmarkSamples({
      operation: "slow-read",
      arm: "state-plane",
      iterations: 3,
      warmups: 0,
      timeoutMs: 5,
      run: (_iteration, signal) =>
        new Promise<string>((_resolve, reject) => {
          active++;
          maxActive = Math.max(maxActive, active);
          const done = () => {
            active--;
            aborts++;
            reject(Object.assign(new Error("aborted"), { code: "aborted" }));
          };
          signal.addEventListener("abort", done, { once: true });
        }),
      hash: String,
    });
    expect(samples).toHaveLength(3);
    expect(
      samples.every((sample) => !sample.ok && sample.errorCode === "timeout"),
    ).toBe(true);
    expect(maxActive).toBe(1);
    expect(active).toBe(0);
    expect(aborts).toBe(3);
  });
});

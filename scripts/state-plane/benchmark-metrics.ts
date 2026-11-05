/** Benchmark measurement primitives shared by the controlled migration runner. */
export interface BenchmarkSample {
  operation: string;
  arm: "legacy" | "state-plane";
  iteration: number;
  latencyMs: number;
  ok: boolean;
  errorCode?: string;
  errorReason?: string;
  outputHash?: string;
}

/** Summarizes measured observations without dropping failed or timed-out attempts. */
export function summarizeBenchmarkSamples(samples: BenchmarkSample[]) {
  const sorted = [...samples].sort((a, b) => a.latencyMs - b.latencyMs);
  const percentile = (p: number) =>
    sorted.length ? sorted[Math.ceil(p * sorted.length) - 1]!.latencyMs : null;
  const successes = samples.filter((sample) => sample.ok).length;
  const elapsedMs = samples.reduce((sum, sample) => sum + sample.latencyMs, 0);
  return {
    count: samples.length,
    successCount: successes,
    failureCount: samples.length - successes,
    failureRate: samples.length
      ? (samples.length - successes) / samples.length
      : 0,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    throughputPerSecond:
      elapsedMs > 0 ? samples.length / (elapsedMs / 1000) : null,
  };
}

/** Runs bounded, sequential timed calls and captures failures as latency samples. */
export async function collectBenchmarkSamples<T>(options: {
  operation: string;
  arm: BenchmarkSample["arm"];
  iterations: number;
  warmups: number;
  timeoutMs: number;
  run: (iteration: number, signal: AbortSignal) => Promise<T>;
  hash: (value: T) => string;
}): Promise<BenchmarkSample[]> {
  const samples: BenchmarkSample[] = [];
  for (
    let iteration = -options.warmups;
    iteration < options.iterations;
    iteration++
  ) {
    const started = performance.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const attempt = Promise.resolve().then(() =>
      options.run(Math.max(0, iteration), controller.signal),
    );
    try {
      const value = await Promise.race([
        attempt,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(
              Object.assign(new Error("benchmark timeout"), {
                code: "timeout",
              }),
            );
          }, options.timeoutMs);
        }),
      ]);
      const latencyMs = performance.now() - started;
      if (iteration >= 0)
        samples.push({
          operation: options.operation,
          arm: options.arm,
          iteration,
          latencyMs,
          ok: true,
          outputHash: options.hash(value),
        });
    } catch (error) {
      if (timedOut) {
        controller.abort();
        // A lane does not start another attempt until its cancelled request settles.
        await attempt.catch(() => undefined);
      }
      const latencyMs = timedOut
        ? options.timeoutMs
        : performance.now() - started;
      if (iteration >= 0)
        samples.push({
          operation: options.operation,
          arm: options.arm,
          iteration,
          latencyMs,
          ok: false,
          errorCode:
            error && typeof error === "object" && "code" in error
              ? String(error.code)
              : "error",
          errorReason:
            error instanceof Error
              ? error.message.slice(0, 240)
              : String(error).slice(0, 240),
        });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return samples;
}

/** Runs warmups as diagnostic samples so failures cannot silently precede timed data. */
export async function collectWarmupSamples<T>(options: {
  operation: string;
  arm: BenchmarkSample["arm"];
  count: number;
  timeoutMs: number;
  run: (iteration: number, signal: AbortSignal) => Promise<T>;
  hash: (value: T) => string;
}): Promise<BenchmarkSample[]> {
  const diagnostics: BenchmarkSample[] = [];
  for (let iteration = 0; iteration < options.count; iteration++) {
    const [sample] = await collectBenchmarkSamples({
      operation: `warmup/${options.operation}`,
      arm: options.arm,
      iterations: 1,
      warmups: 0,
      timeoutMs: options.timeoutMs,
      run: (_ignored, signal) => options.run(iteration, signal),
      hash: options.hash,
    });
    diagnostics.push({ ...sample!, iteration });
  }
  return diagnostics;
}

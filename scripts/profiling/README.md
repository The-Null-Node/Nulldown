# Local profiling checks

Run from the repository root with the existing locked Bun dependencies. Use an
approved native workerd executable that supports the collector's compatibility
date; set `MINIFLARE_WORKERD_PATH` to that executable. These commands never install
or upgrade dependencies automatically and never deploy or contact the hosted API.

```sh
bun run test:profiling
bun run profiling:bench
bun run profiling:inspect .profiling/captured-profile.json
```

`test:profiling` runs the focused protocol regressions, builds the current Pages
routes offline, starts disposable native D1/R2 and the same collector code, then
checks authenticated append/read parity, genuine detail saturation, exact identity
replay, stale rejection, malformed evidence, completion compatibility, cookie lists
and exporter failures. The native fixture's external rate-limit binding is a local
allow fixture; production rate-limit behavior is not claimed. Application auth and
storage implementations are not replaced. All workers are disposed afterward.

`profiling:bench` additionally runs repeated16-event append/read workloads with
rotating mode order and a separate128-operation host instrumentation proxy.
Every mode/round gets a distinct root; accepted16/deduplicated0 and snapshot0→1
are asserted so a cached/replayed receipt cannot masquerade as an append sample.
`PROTOCOL.json` declares sample counts, warm/cold labels and numerical LOCAL
budgets before any measurement. Host wall includes local storage and audit costs;
it is not deployed network latency or Workers billed CPU. Export/background tasks
are observed separately, outside response measurement. Inclusive nested phase sums
overlap and must not be added as exclusive time.

Every run creates a numbered source/config/artifact snapshot under `.profiling/`,
then seals it using a separate `shasum` process before requests. The fixtures verify
the seal, all source hashes, lock and runtime identity before running. Rebuilds or
source changes require a new snapshot. Raw samples, p50/p95, budget results, exact
commands and log hashes remain in this ignored directory. Archive/hash a run before
rerunning; normal result files are replaced, while numbered snapshots are retained.

No credentials are read from a user auth directory: subprocesses use an empty HOME,
an environment allowlist and memory-only fixture tokens. The compiler is network
denied; fixture egress is denied and counted. Missing sinks, rejected batches,
timeouts, pending phases and dropped detail mean incomplete evidence, never zero
latency. Inspect only validated version2 batches. Exclusive time is unknown unless
root-excluded counts/errors/timings reconcile and the retained parent/child intervals
are complete. The1ns interval tolerance covers arithmetic reconstruction only.

The production source contract and controls are documented in
[`docs/OBSERVABILITY.md`](../../docs/OBSERVABILITY.md). Local checks are not release,
production-overhead, inference, durable-recovery or peer-consistency acceptance.

The Bun protocol suite has its own strict `typecheck:profiling` target and the
collector has `typecheck:telemetry`; both run before the native fixture. Worker
fixtures and their generated bundle imports are excluded from the Node CLI
typecheck because they execute in workerd, not Node. Application source remains
covered by the normal functions/shared/server checks; fixture behavior is checked
against the actual compiled runtime, including malformed evidence and failures.

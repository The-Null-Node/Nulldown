# Observability and request profiling

One private service-binding collector owns completion events and optional request
profiling. `shared/observability/` owns the finite content-free wire contracts;
`functions/api/_lib/core/observability/` owns request-local observation, bounded
delivery and ingestion. Telemetry is not canonical product state or authority.

## Compatible endpoint contracts

- `/server` and `/browser` retain the version1 completion ARRAY protocol with UUID
  operation/request identifiers. Browser reports remain separately labelled and
  rate-limited; they are not evidence of authenticated server identity.
- `/v1/phases` accepts version1/2 phase BATCH OBJECTS with random trace/span IDs,
  only in logical staging. Version2 adds a fixed-cardinality summary. Endpoint and
  shape dispatch is explicit: a completion array is never a phase version1 batch.

Existing production completion ingestion remains compatible. Phase support must
be released collector-first before a producer explicitly selects version2. This
document does not enable any production flag, binding or collector environment.

## Deployment-owned controls

Profiling defaults off. It requires `STAGING_TELEMETRY_ENABLED=1`,
`STAGING_TELEMETRY_ENVIRONMENT=staging`, the existing `TELEMETRY` binding and a live
request context. An incoming header supplies correlation only, never permission.

| Setting                             | Behavior                                                |
| ----------------------------------- | ------------------------------------------------------- |
| `STAGING_PROFILING_MODE=off`        | No profiling observer/store wrappers or export          |
| `summary`                           | Version2 summary and reserved root, no waterfall detail |
| `detailed`                          | Version2 summary plus bounded sampled detail            |
| mode unset with legacy enable gate  | Compatible version1 detailed producer                   |
| invalid mode or missing gate        | Off                                                     |
| `STAGING_PROFILING_SAMPLE_PERMILLE` | Detailed sampling0..1000, default1000; invalid0         |

Sampling is independently selected per request, not derived from trace flags.
Unsampled detailed requests still produce summaries. Disable with mode off or the
original kill switch. These controls concern profiling, not legacy completion
events. Rollback the explicit producer before reverting collector protocol support.

## Bounds and interpretation

Shared delivery is one best-effort service-binding attempt: manual/no-follow,
strict204,500ms absolute lifetime and no retry. Ingestion has the same absolute
lifetime and at most256 stream reads, including empty chunks. Closed `waitUntil`
or unavailable sinks cannot replace application responses or failures.

Legacy batches remain capped at20 events/16384 bytes. Phase batches retain the
49152-byte overall cap with8192 bytes reserved for at most44 allowlisted phase
aggregates and at most96 detail records including root. Summaries continue after
detail saturation. Pending, cap losses, unfinished/byte-truncated records and
numeric truncations are explicit. Summary/unsampled detail omission is intentional,
not reported as capacity loss. Root is reserved and excluded from operation counts.

Per-phase counts, completed errors, sums and maxima reconcile against retained
detail. Retained children require acyclic parentage and contained intervals. The
only tolerance is1ns for bounded floating arithmetic. Invalid or partial evidence
cannot certify exclusive time. Complete waterfalls subtract direct-child interval
unions; nested replay/commit/storage durations are inclusive and overlap. Workers
clocks may report sub-resolution CPU phases as0ms; that is not a CPU cost claim.

Only finite allowlisted phase/outcome/status/duration/count fields and validated
tracing context leave the producer. No bodies, prompts, raw document/object IDs,
paths, SQL, headers, exception text or credentials are exported. No global mutable
request trace context is used. API cookie lists and canonical auth/storage/fencing
semantics are preserved. Dependency unavailability is distinguished from invalid
credentials and does not silently clear a recoverable session or active vault.

See [`scripts/profiling/README.md`](../scripts/profiling/README.md) for reproducible
baseline, bounded collection, inspection and comparison commands. Local evidence
does not prove deployment, production collection, latency, recovery or peer parity.

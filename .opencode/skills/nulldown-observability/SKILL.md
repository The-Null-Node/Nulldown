---
name: nulldown-observability
description: Instrument and verify Nulldown behavior changes, failure paths, and production diagnostics across browser, API, storage, CLI, and MCP surfaces.
---

# Nulldown Observability

Read hosted strategy root `VU7pv5CWU6as` before selecting telemetry changes.
Until a strategyRef is published, query branch
`clone_account:2d89645f-f4b5-40be-a890-9e279ff4c46b` explicitly.

- Identify changed user actions, service boundaries, and consequential state transitions.
- Reuse stable event names and bounded, allowlisted fields. Include outcome and reason.
- Preserve operation identity across retries and request correlation across dependencies.
- Derive actor references from authenticated server context.
- Never log document contents, tokens, cookies, OTPs, recovery codes, or private keys.
- Record dependency unavailability separately from rejected credentials or permissions.
- Verify success, rejection, retry, and failure paths appropriate to the change.
- Ensure telemetry failure cannot break application behavior.
- Verify retained production events before claiming production observability; passing local tests is not deployment evidence.
- Report coverage, verification, and remaining collection gaps. Explain when a change has no observable behavior impact.

Reusable procedure: `memproc:b65ed800-d40b-4881-98d4-262fb9060c56` on that branch.
Load `nulldown-stale-memory-check` before trusting procedure memory, then retrieve
the procedure through `memory_query`. Step statuses describe a reusable template,
not evidence that a particular implementation or deployment has completed.

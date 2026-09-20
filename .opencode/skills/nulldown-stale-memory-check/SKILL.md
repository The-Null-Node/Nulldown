---
name: nulldown-stale-memory-check
description: Checks Nulldown branch memory for staleness and supersession before current-work, procedure, or capability records influence planning.
---

# Nulldown Stale Memory Check

Call `memory_stale_check` before trusting branch memory, then compare the record
with current authoritative branch state. Old snapshots, missing session
provenance, or another worktree mean unknown or needs-review, not automatically
stale. Preserve provenance; supersede or delete only with explicit hosted-write
authorization.

## Hosted Strategy

Canonical strategy program: https://nulldown.app/d/VfrzR4

Related onboarding procedure: https://nulldown.app/d/TYddJA. Load the strategy
root through `strategy_get`; use memory tools directly rather than shelling out.

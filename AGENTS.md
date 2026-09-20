# Agent Instructions

This repository is the Nulldown codebase. Work as a careful, minimal-change engineering agent.

## Public Context Boundary

- Internal plans, authorization checks, test transcripts, provenance, branch
  identities, and completion procedures constrain the work; they are not source
  prose for public documentation.
- Load `nulldown-public-docs` before product copy, onboarding, tutorial, voice,
  or public information-architecture work. Use `docs-audit` only afterward for
  factual verification and narrow corrections.
- Prefer direct Nulldown MCP tools for agent workflows. Use the CLI only for an
  explicitly CLI-facing task or a capability the MCP surface does not provide.

## Nulldown First (Non-Negotiable)

Before starting any architecture, refactor, planning, checklist, strategy, skill, agent-memory, agent behavior, contract, or hosted data work:

- Load `nulldown-priority-strategy` (or read the SKILL.md directly and run the mandatory first query if the skill is not available).
- Run the hosted priority query on the master checklist and relevant child plans before local planning or coding.
- For any write to a hosted plan, checklist, strategy, or memory, also load `nulldown-atomic-diffs`.

This is a hard gate. Do not skip it. Do not start making changes based on local intuition.

## Hosted Writeback

Hosted writes are opt-in and require explicit authorization for the target
roots and record classes. Local implementation does not authorize hosted
writeback.

When authorized after a change affects architecture, agent/MCP/CLI behavior,
contracts, response handling, data presentation from hosted sources, or
documented strategy/procedures:

You **must** perform this ritual before considering the work complete:

1. Identify the relevant hosted Nulldown root(s) — usually the master checklist and the appropriate child plan.
2. Update hosted content with direct MCP `diff_apply` when available, using small atomic branch diffs and proper metadata. Use `nd diff apply` for an explicitly CLI-facing workflow or when MCP lacks the operation.
3. Record a memory fact or procedure only when that record class is included in the authorized scope.
4. Verify the update is retrievable with a `branch query`.
5. Only then move on.

When canonical writeback is needed but not authorized, report it as pending and
do not claim that hosted state changed.

Trigger examples (use categories, not specific symbols):
- Changing rules or behavior for how agents retrieve or present information from hosted plans/memory.
- Modifying architecture, contracts, or observable behavior that other work should follow.
- Adding or changing agent procedures, best practices, or instructions that should be discoverable later.
- Any work that should become part of the canonical plans or memory.

Do not hard-code current implementation names in the ritual. Keep it general so it applies broadly.

## Stale Memory & Memory Hygiene

- Before trusting branch memory (especially current-work, procedure-memory, capability records) for priority, load `nulldown-stale-memory-check`.
- If the runtime cannot load it, read the SKILL.md directly and run the stale detection + supersede workflow.
- Delete stale records when possible, or write an explicit superseding `stale-memory` fact.

## Development Rules

- Prefer small, behavior-preserving changes over broad rewrites.
- Do not add deprecated aliases or compatibility barrels unless the user explicitly asks for persisted or external compatibility.
- Do not touch unrelated dirty files, generated files, `.DS_Store`, or local notes.
- Use Bun-native commands: `bun install`, `bun run test`, `bun run build`, `bun run cli:build`, and `bun run nd -- ...`.
- Prefer direct MCP tools for agent reads and writes. Use `nd` for CLI behavior, real CLI smoke tests, and operations that MCP does not expose; do not insert shell commands into an MCP workflow.
- Use `bun run format:check`, `bun run lint`, and `bun run typecheck` for the local tooling baseline; run each `typecheck:<surface>` separately when the aggregate stops early. Existing debt is diagnostic until the baseline is accepted. Format only explicitly approved paths; do not bulk-fix source or add CI enforcement in the baseline slice.

## Naming Rules

- Name modules and types for their domain responsibility and runtime lifetime. Distinguish persisted records from request-scoped services, platform adapters, and application composition.
- Use domain-scoped capabilities and explicit dependencies; a universal facade or `Void*` prefix is not mandatory. Keep existing names unless a rename is explicitly in scope.

## Boundary Rules

- Storage receives sealed envelopes only; it must not receive plaintext or own crypto.
- Crypto seals, opens, signs, and verifies; it must not own persistence.
- Backend routes are thin HTTP adapters. Do not put crypto, signing, HMAC verification, R2 key layout, or branch mutation logic directly in route files.
- Shared code must not import browser APIs, React, Cloudflare runtime APIs, or Node-only APIs.
- Browser code must not contain server private-key behavior.
- Server code must not depend on browser vaults or UI state.

## Documentation Rules

- Before choosing or planning architecture work, load `nulldown-priority-strategy`. Before any Nulldown-hosted plan or document write, load `nulldown-atomic-diffs`. Agents that skip these will silently violate the Nulldown editing model.
- Do not create new `.nmdn` docs on disk for refactor planning. When hosted publication is authorized, publish plans as Nulldown drops through the selected native surface; otherwise keep the plan local.
- Keep `AGENTS.md` short and prompt-like; do not turn it into the full architecture plan.
- Update `README.md` when public docs, commands, or architecture entry points change.
- Every exported architecture interface, class, and function needs TSDoc describing its domain responsibility and lifetime.

## Verification Rules

- Run focused tests for touched modules.
- Run `bun run build` after import, module-boundary, or frontend changes.
- Run `bun run cli:build` after CLI or shared API changes.
- Run a real `nd` smoke test when changing CLI, diff, branch, or remote storage behavior.

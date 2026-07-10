# Agent Instructions

This repository is the Nulldown codebase. Work as a careful, minimal-change engineering agent.

## Nulldown First (Non-Negotiable)

Before starting any architecture, refactor, planning, checklist, strategy, skill, agent-memory, agent behavior, contract, or hosted data work:

- Load `nulldown-priority-strategy` (or read the SKILL.md directly and run the mandatory first query if the skill is not available).
- Run the hosted priority query on the master checklist and relevant child plans before local planning or coding.
- For any write to a hosted plan, checklist, strategy, or memory, also load `nulldown-atomic-diffs`.

This is a hard gate. Do not skip it. Do not start making changes based on local intuition.

## Post-Change Hosted Update Ritual (Mandatory)

After implementing changes that affect architecture, agent/MCP/CLI behavior, contracts, response handling, data presentation from hosted sources, or documented strategy/procedures:

You **must** perform this ritual before considering the work complete:

1. Identify the relevant hosted Nulldown root(s) — usually the master checklist and the appropriate child plan.
2. Update the hosted content using small atomic branch diffs (`nd diff apply`) with proper metadata (kind, intent, labels, args.summary, priority).
3. Record a memory fact (and a procedure when the work defines a reusable workflow).
4. Verify the update is retrievable with a `branch query`.
5. Only then move on.

Local code or instruction changes are not enough. The hosted Nulldown is the source of truth that future agents will query.

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
- Prefer the `nd` CLI for real Nulldown smoke tests and document publishing workflows.

## Naming Rules

- `Drop*` names are for persisted/domain records such as `DropPayload`, `DropEnvelopeV1`, `DropDiffEvent`, and `DropBranchRecord`.
- `Void*` names are for runtime architecture such as `VoidProvider`, `VoidCrypto`, `VoidStorage`, and `VoidGraph`.
- `VoidProvider` is the master app-facing facade.
- `DropProviderPort` is only a child local, remote, or server capability port under `VoidProvider`.
- Do not reintroduce `DropProvider` as an app-facing abstraction.

## Boundary Rules

- Storage receives sealed envelopes only; it must not receive plaintext or own crypto.
- Crypto seals, opens, signs, and verifies; it must not own persistence.
- Backend routes are thin HTTP adapters. Do not put crypto, signing, HMAC verification, R2 key layout, or branch mutation logic directly in route files.
- Shared code must not import browser APIs, React, Cloudflare runtime APIs, or Node-only APIs.
- Browser code must not contain server private-key behavior.
- Server code must not depend on browser vaults or UI state.

## Documentation Rules

- Before choosing or planning architecture work, load `nulldown-priority-strategy`. Before any Nulldown-hosted plan or document write, load `nulldown-atomic-diffs`. Agents that skip these will silently violate the Nulldown editing model.
- Do not create new `.nmdn` docs on disk for refactor planning. Publish refactor plans as real Nulldown drops with `nd create`.
- Keep `AGENTS.md` short and prompt-like; do not turn it into the full architecture plan.
- Update `README.md` when public docs, commands, or architecture entry points change.
- Every exported architecture interface, class, and function in the `Void*` refactor needs TSDoc.

## Verification Rules

- Run focused tests for touched modules.
- Run `bun run build` after import, module-boundary, or frontend changes.
- Run `bun run cli:build` after CLI or shared API changes.
- Run a real `nd` smoke test when changing CLI, diff, branch, or remote storage behavior.

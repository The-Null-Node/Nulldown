# Agent Instructions

This repository is the Nulldown codebase. Work as a careful, minimal-change engineering agent.

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

- Before any Nulldown-hosted plan or document work, load the `nulldown-atomic-diffs` skill. The skill defines the atomic diff protocol, metadata requirements, query-first retrieval workflow, semantic memory writes, and common anti-patterns. Agents that skip this will silently violate the Nulldown editing model.
- Do not create new `.nmdn` docs on disk for refactor planning. Publish refactor plans as real Nulldown drops with `nd create`.
- Keep `AGENTS.md` short and prompt-like; do not turn it into the full architecture plan.
- Update `README.md` when public docs, commands, or architecture entry points change.
- Every exported architecture interface, class, and function in the `Void*` refactor needs TSDoc.

## Verification Rules

- Run focused tests for touched modules.
- Run `bun run build` after import, module-boundary, or frontend changes.
- Run `bun run cli:build` after CLI or shared API changes.
- Run a real `nd` smoke test when changing CLI, diff, branch, or remote storage behavior.

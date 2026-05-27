# Nulldown

Nulldown is a Markdown-native document runtime for encrypted drops, branch-based editing, atomic diffs, resolved heaps, and nullplug execution.

The public app is hosted at [https://nulldown.app](https://nulldown.app).

Public documentation starts at [https://nulldown.app/d/K7kgGh](https://nulldown.app/d/K7kgGh).

## Core Concepts

- Drops are persisted document payloads or sealed `nmdn.drop.v1` envelopes.
- The void runtime is the app-facing provider, crypto, storage, and graph architecture.
- Branches are writable edit streams rooted at drops.
- Diffs are append-only edit events that materialize branch content and snapshots.
- Resolved heaps store derived document/runtime facts for branch snapshots.
- Nullplugs are Markdown-embedded runtime integrations.

## Refactor Plan

Refactor plans are real Nulldown drops, not repo-local `.nmdn` files.

| Area | Drop |
| --- | --- |
| Master checklist | https://nulldown.app/d/1wrhjx |
| Target architecture | https://nulldown.app/d/ODuywL |
| Docs foundation | https://nulldown.app/d/S6ptyz |
| Void provider | https://nulldown.app/d/D1JGec |
| Crypto and storage | https://nulldown.app/d/Z64oPj |
| Backend services | https://nulldown.app/d/xLKsZS |
| Branches and diffs | https://nulldown.app/d/ocQBBs |
| Tests and smoke | https://nulldown.app/d/6eC0Jc |

## Development

Install dependencies:

```bash
bun install
```

Run the Vite dev server:

```bash
bun run dev
```

Run the Cloudflare Pages dev server with Functions:

```bash
bun run pages:dev
```

Build the web app:

```bash
bun run build
```

Run tests:

```bash
bun run test
```

Build the CLI executable:

```bash
bun run cli:build
```

## CLI

Run the CLI from the checkout:

```bash
bun run nd -- --help
```

Create a drop:

```bash
bun run nd -- create README.md --json
```

Fetch a drop:

```bash
bun run nd -- get <id> --json
```

Use a local or preview API base:

```bash
bun run nd -- --base=http://127.0.0.1:8788 get <id> --json
```

Global installs store CLI state in `~/.config/nulldown` by default.

## Cloudflare

The app is designed for Cloudflare Pages Functions with an R2 binding named `R2_BUCKET`.

Required production configuration:

- `PUBLIC_BASE_URL`
- `R2_BUCKET` Pages Functions binding
- provider signing and escrow keys when provider-assisted unlock is enabled
- branch/diff/admin tokens when using protected maintenance APIs

Deploy:

```bash
bun run deploy
```

## Repository Rules

Agent and contributor rules live in `AGENTS.md`.

Highlights:

- Use `Drop*` names for persisted/domain records.
- Use `Void*` names for runtime architecture.
- Keep storage sealed-envelope-only.
- Keep crypto separate from persistence.
- Keep backend routes thin HTTP adapters.
- Use `nd` for real Nulldown document publishing and smoke tests.

## License

MIT

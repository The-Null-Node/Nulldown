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

Serve the API locally with filesystem blob storage and SQLite metadata:

```bash
bun run nd -- serve --host 127.0.0.1 --port 8788 --data-dir .nulldown-data
```

The local server supports core drop, diff, branch, and resolved-query routes using filesystem blobs plus SQLite metadata. Generic functional snapshot data is still in-memory unless a future adapter is provided. Use `--migrations-dir` to override the migration path or `--no-sqlite` to run with blob fallback only.

Attach an agent priority fact to a resolved node so future branch queries rank it earlier:

```bash
bun run nd -- --account <accountId> branch priority <rootId> <branchId> --node <nodeId> --priority 3 --reason "important for the next agent"
bun run nd -- --account <accountId> branch priority list <rootId> <branchId>
bun run nd -- --account <accountId> branch priority delete <rootId> <branchId> <factId>
```

Run the same local server in Docker with `/data` as the persistent volume:

```bash
docker build -t nulldown .
docker run --rm -p 8788:8788 -v nulldown-data:/data nulldown
```

Global installs store CLI state in `~/.config/nulldown` by default.

## Cloudflare

The app is designed for Cloudflare Pages Functions with R2 blob storage and a D1 metadata/index database.

Required production configuration:

- `PUBLIC_BASE_URL`
- `R2_BUCKET` Pages Functions binding
- `DB` D1 binding with migrations in `migrations/`
- provider signing and escrow keys when provider-assisted unlock is enabled
- branch/diff/admin tokens when using protected maintenance APIs

Admin backfills:

```bash
bun run nd -- admin metadata-backfill --token <token> --json
```

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

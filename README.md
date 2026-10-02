# Nulldown

**Markdown that stays readable while people and agents work on it together.**

Nulldown keeps a Markdown document, its history, and the context around each change
together. You can read the document normally, replay how it reached its current
state, retrieve the part an agent needs, or use it to drive a workflow or interface.

That means one source can serve people, agents, workflows, memory, and interfaces
without copying the same work into disconnected prompts, databases, and component
state.

## Start With A Document

Imagine a release plan:

```markdown
# Release plan

- [ ] Run the migration
- [ ] Verify the rollout
- [ ] Publish the release notes
```

In Nulldown:

- a person or agent can update the checklist;
- each accepted change keeps its source client and context;
- a query for "rollout" can return the matching section and point to its source;
- another branch can explore a different release path without replacing this one.

The result is still Markdown. Nulldown adds durable state and retrieval around it.

## What It Enables

- plans, specifications, and knowledge that people and agents can share;
- focused retrieval tied back to exact document ranges;
- reviewable automation where the change and its intent travel together;
- separate timelines for experiments, reviews, and publication;
- reusable memory and document-driven interfaces near their source material.

## Try It

The current `0.0.9` prerelease is published under the `next` tag and requires
[Bun](https://bun.sh).

```bash
bun install -g @thenullnode/nulldown@next
nd --version
cat > release-plan.md <<'MARKDOWN'
# Release plan

- [ ] Run the migration
- [ ] Verify the rollout
- [ ] Publish the release notes
MARKDOWN
nd create release-plan.md --json
nd get <document-id> --raw
```

`nd create --json` returns a document ID and URL. Without an authoring credential,
this example stores plaintext at `nulldown.app`; anyone with the link can read it,
so use only non-sensitive sample content.

## Choose Your Surface

- **Web:** read, write, and share documents at [nulldown.app](https://nulldown.app).
- **Agents:** use the [MCP server](packages/nulldown-mcp/README.md) for focused
  retrieval, attributed changes, reusable memory, and strategy.
- **Automation:** use the [CLI and HTTP API](docs/NULDOWN_API.md) for documents,
  branches, diffs, queries, and publication.
- **Self-hosting:** run the portable API with filesystem blobs and SQLite metadata.
- **Concepts:** start with the [Nulldown documentation](https://nulldown.app/d/qP3Mi4).

## How The Model Fits Together

1. **Document** — readable Markdown with a stable identity.
2. **Change** — an ordered diff event that can carry intent, labels, confidence,
   references, and explicit priority.
3. **Current state** — the Markdown produced by replaying accepted changes.
4. **Snapshot** — an exact state at a point in the branch timeline.
5. **Branch** — an independent timeline rooted in a document.
6. **Query** — bounded structural retrieval with source ranges and ranking context.
7. **Publication** — an explicit choice to update an owned document or promote a
   reviewed snapshot into a new document.

Priority can affect authorized retrieval for the changed region. Intent,
confidence, labels, and references explain the action. None of these signals prove
that a claim is true.

## Work With A Branch

The normal hosted branch workflow uses an account. The CLI opens a browser-assisted
device login and stores its refreshable credential in the private Nulldown config
directory.

```bash
nd auth login
nd branch resolve <document-id> --json
nd branch content <root-id> <branch-id> --json
nd branch query <root-id> <branch-id> --query "rollout" --top 3 --json
```

Use `branch query` when you need the smallest relevant structure. Fetch exact branch
content when you need to edit, verify a claim, or inspect the complete document.

An authoring-capable login can create account-owned sealed documents with `private`,
`unlisted`, or `public` visibility. See
[Privacy and access](https://nulldown.app/d/prO0pe) before using sensitive content.

## Agents And MCP

Install the MCP prerelease:

```bash
bun install -g @thenullnode/nulldown-mcp@next
```

The server exposes focused tools for documents, branches, diffs, resolved queries,
strategy, and NullMem. It is a stdio MCP server configured by your MCP client; it is
not an interactive terminal program.

See [Connect an agent](https://nulldown.app/d/NVJIa8) for the shortest setup path and
the [MCP package README](packages/nulldown-mcp/README.md) for authentication,
configuration, tool groups, and retry behavior.

## Documentation

- [Why Nulldown](https://nulldown.app/d/jjDqJJ)
- [Understand document state](https://nulldown.app/d/7UWCph)
- [Work with Nulldown as an agent](https://nulldown.app/d/ashG9C)
- [Use documents as interfaces](https://nulldown.app/d/7t8MZQ)
- [Documents and changes](https://nulldown.app/d/AGJtdX)
- [Ways to use Nulldown](https://nulldown.app/d/VD4rpR)
- [Full documentation index](https://nulldown.app/d/qP3Mi4)

Current limitations and release status live in
[Project status](https://nulldown.app/d/XG80QG).

The local [`docs/`](docs/README.md) directory contains source-coupled API and
operational references.

## Self-Host

Run the API locally with filesystem blob storage and SQLite metadata:

```bash
nd serve --host 127.0.0.1 --port 8788 --data-dir .nulldown-data
```

Or run it in Docker with `/data` as the persistent volume:

```bash
docker build -t nulldown .
docker run --rm -p 8788:8788 -v nulldown-data:/data nulldown
```

The portable server supports core document, branch, diff, resolved-query, priority,
and NullMem routes. It is not a packaged replacement for every hosted route or the
web application.

## Development

```bash
bun install
bun run test
bun run build
bun run cli:build
bun run package:check-cli
bun run package:check-mcp
```

Run `bun run format:check`, `bun run lint`, and `bun run typecheck` for the local
tooling baseline. Repository contribution rules live in [AGENTS.md](AGENTS.md).

## License

MIT

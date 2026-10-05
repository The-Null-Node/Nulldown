# Nulldown

**Markdown with durable state for agents to execute and reuse.**

Give agents plans they can act on, results they can inspect, and knowledge they can
carry into the next task. Instead of reconstructing what happened from scattered
conversations, they can retrieve recorded decisions, follow procedures, and build
on previous work.

Markdown is already familiar to humans and agents. Nulldown adds persistent state,
structured retrieval, and execution context, so the same document can guide the
work and keep a record of its results.

## What You Can Build

- **Agent orchestration:** coordinate agents through shared plans, procedure steps,
  results, and handoffs. Your agent framework runs the agents; Nulldown keeps their
  shared context available.
- **Long-term memory:** preserve findings, decisions, and reusable procedures
  beyond a conversation, with sources the next session can check.
- **Collaborative Markdown:** contribute recorded changes, review independent
  timelines, and recover conflicting edits before publishing.
- **Executable Markdown:** connect instructions to agent-executed procedures and
  runtime-backed interactions, then record their outcomes.
- **Document-driven interfaces:** put reviews, approvals, and workflow views beside
  the content they depend on.

## From One Release To The Next

Start with a release plan:

```markdown
# Release plan

- [ ] Run the migration
- [ ] Verify the rollout
- [ ] Publish the release notes
```

An agent retrieves the plan and rollout-check procedure, runs the check, and
records its result with a link to the evidence. A reviewer records an approval.
The next agent reads that decision and continues from the saved state.

After review, the team saves the useful method as a reusable procedure. The next
release starts with that method and its sources, then records fresh results.

**Read the context → execute a step → record the result → reuse what worked.**

The agent or configured runtime executes the actions. The document holds the
instructions, context, and outcomes that make the work inspectable and reusable.

## Connect An Agent

Install the matching MCP and core packages:

```bash
bun install -g @thenullnode/nulldown@0.0.9 @thenullnode/nulldown-mcp@0.0.9
```

Add `nulldown-mcp` as a local stdio server in your MCP client. Follow
[Connect an agent](https://nulldown.app/d/NVJIa8) for account setup, a first recorded
change, and retrieving the result in another session. The
[MCP package README](packages/nulldown-mcp/README.md) covers configuration and tool
contracts.

## Try The CLI

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
- **Concepts:** start with the [Nulldown documentation](https://nulldown.app/d/kzgJGL).

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

## Documentation

- [Why Nulldown](https://nulldown.app/d/TQHCCo)
- [Coordinate agents around a shared plan](https://nulldown.app/d/UeifJr)
- [Reuse knowledge across agent sessions](https://nulldown.app/d/2jvr1e)
- [Execute a procedure and record its result](https://nulldown.app/d/6Cy3H4)
- [Review and recover collaborative edits](https://nulldown.app/d/SEbKiW)
- [Understand document state](https://nulldown.app/d/m255tk)
- [Work with Nulldown as an agent](https://nulldown.app/d/J8V2nm)
- [Use documents as interfaces](https://nulldown.app/d/NyInTa)
- [Documents and changes](https://nulldown.app/d/AGJtdX)
- [Choose an interface](https://nulldown.app/d/VD4rpR)
- [Full documentation index](https://nulldown.app/d/kzgJGL)

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

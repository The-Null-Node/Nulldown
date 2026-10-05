# @thenullnode/nulldown-mcp

`@thenullnode/nulldown-mcp` connects agents to durable Markdown state. Agents can retrieve a plan, follow a saved procedure, record results, and reuse knowledge in a later session through MCP tools.

The server provides focused document queries, attributed edits, and branch-scoped memory. Your agent executes the tools; Nulldown preserves the context and evidence it needs to continue.

## Install

The `0.0.9` MCP prerelease is available under the `next` tag and requires core
`>=0.0.9 <0.1.0`. Install the matching pair for the connection walkthrough:

```bash
bun install -g @thenullnode/nulldown@0.0.9 @thenullnode/nulldown-mcp@0.0.9
```

From this repository checkout:

```bash
bun run --silent mcp
```

The package also exposes the `nd-mcp` binary.

## Configure A Client

Use `nulldown-mcp` as a stdio MCP command. The client starts the server; it is not an interactive terminal program. Client configuration formats vary; a client using `mcpServers` might use:

```json
{
  "mcpServers": {
    "nulldown": {
      "command": "nulldown-mcp",
      "env": {
        "ND_BASE_URL": "https://nulldown.app",
        "ND_AUTH_FILE": "/absolute/path/to/opencode-mcp-auth.json",
        "ND_MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Create the dedicated credential while the MCP server is stopped:

```bash
env -u ND_TOKEN nd --auth-file /absolute/path/to/opencode-mcp-auth.json auth login --name opencode-nulldown-mcp
```

The credential directory is private (`0700`) and the credential file is private (`0600`). One MCP process must own each credential file because refresh-token rotation is single-use. `ND_TOKEN` remains an authentication-only compatibility option; it cannot create an account-owned sealed drop. `ND_ACCOUNT_ID` is only for local or development APIs that explicitly set `ALLOW_INSECURE_ACCOUNT_HEADER=1`; an invalid bearer credential does not fall back to it. `ND_MCP_LOG_LEVEL` accepts `silent`, `error`, `warn`, `info`, or `debug`; stdio reserves stdout for JSON-RPC and diagnostics use stderr only.

## Account-Owned Creation

With an authoring-capable `ND_AUTH_FILE`, `drop_create` seals a delegated account-owned envelope by default. Its `visibility` input accepts `private`, `unlisted`, or `public` and defaults to `unlisted`; public and unlisted envelopes use the public-only `VITE_PROVIDER_ENCRYPTION_PUBLIC_JWK` escrow configuration. Never set that variable to a private JWK.

An older auth file without local authoring material fails deterministically with a request to run `nd auth login` again. `ND_TOKEN` alone is not authoring authority and receives the same error. For a deliberate legacy plaintext write, set `legacyPlaintext: true`; MCP emits a stderr warning and the resulting authenticated plaintext drop will not enter Remote Library.

For an exact `diff_apply` retry, provide `eventId` and `createdAt` together with
the original operations and metadata. The tool rejects partial identities before
network I/O and treats a missing or mismatched acknowledgement as unconfirmed.

## Tool Groups

| Group          | Purpose                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------- |
| Drop tools     | Read and inspect persisted Nulldown documents.                                                 |
| Branch tools   | Resolve a branch, fetch exact branch content, query resolved structure, and apply diff events. |
| Memory tools   | Query freshness-aware NullMem facts and procedures, then record reusable verified knowledge.   |
| Strategy tools | Read Nulldown-hosted strategy and documentation drops.                                         |

Use `branch_query` before `branch_content` whenever possible. Queries return structural nodes with source ranges and ranking context; fetch exact content only when an edit, claim, or decision requires it.

Public and unlisted document queries can be read by identifier without credentials.
Runtime-resolver and non-document snapshotter queries require a trusted canonical
owner or exact branch-writer credential. NullMem queries without that authority are
limited to `public-memory` records on public, unlisted, and legacy-readable roots and
cannot enumerate remote capability catalogs; unauthorized private roots return `404`.

## Response Discipline

`strategy_get` (SDK: `client.readStrategy`) uses an explicit `branchId` without
reading the root. Otherwise it reads the root once and follows plaintext payload
metadata `strategyRef: { kind: "branch", rootDropId: "<canonical same root>", branchId: "<explicit branch>" }`.
Both ids must be nonempty trimmed strings. Short input ids are checked against the
canonical id returned by the root read. Without a reference it stays a labeled root
read; `query`, `snapshotId` and `top` require an explicit or metadata-selected branch.
Reads never resolve/create branches, follow references recursively, or fall back
after invalid/cross-root references or branch errors. Routing is not authorization.
Envelope metadata is not followed and no secrets are decrypted. Existing drops are
not migrated: publishing a branch and revision-safely updating its original root's
metadata are separate explicit actions; preserve the root content and other metadata.
Output defaults to 800 approximate tokens (`maxTokens`, 100-8000), bounded to
`maxTokens * 4` serialized characters even with `format: "full"` or `preview: false`.
Root/branch/snapshot identity, partial/truncated flags and requery guidance survive
payload truncation. `getDrop` / `drop_get` remain the raw root read interfaces.

Read/query tools use compact responses by default and accept response controls where supported:

| Input       | Meaning                                   |
| ----------- | ----------------------------------------- |
| `preview`   | Request compact preview behavior.         |
| `maxTokens` | Set an approximate response budget.       |
| `format`    | Choose `compact` or `full` serialization. |

Compactness is a transport guard, not a substitute for correct retrieval. Agents should query the relevant branch/heap first, check freshness for memory used as current-work guidance, and expand exact sources only when needed.

## Learn More

- [Nulldown documentation](https://nulldown.app/d/kzgJGL)
- [Why Nulldown](https://nulldown.app/d/TQHCCo)
- [Work with Nulldown as an agent](https://nulldown.app/d/J8V2nm)
- [Connect an agent](https://nulldown.app/d/NVJIa8)

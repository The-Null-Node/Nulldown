# @thenullnode/nulldown-mcp

`@thenullnode/nulldown-mcp` is the stdio MCP server for Nulldown's deterministic Markdown structure. It gives agents structured access to drops, branches, diff events, resolved queries, and NullMem without requiring shell commands.

Nulldown turns Markdown into deterministic structure. This server lets an MCP client retrieve the smallest relevant branch structure, follow source references, apply attributable diffs, and retain reusable facts or procedures near their evidence.

## Install

```bash
bun install -g @thenullnode/nulldown-mcp
nulldown-mcp
```

From this repository checkout:

```bash
bun run bin/nulldown-mcp.ts
```

The package also exposes the `nd-mcp` binary.

## Configure A Client

Use `nulldown-mcp` as a stdio MCP command. For example:

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

The credential directory is private (`0700`) and the credential file is private (`0600`). One MCP process must own each credential file because refresh-token rotation is single-use. `ND_TOKEN` remains an authentication-only compatibility option; it cannot create an account-owned sealed drop. `ND_ACCOUNT_ID` is only for local or development APIs that explicitly enable the insecure account header. `ND_MCP_LOG_LEVEL` accepts `silent`, `error`, `warn`, `info`, or `debug`; stdio reserves stdout for JSON-RPC and diagnostics use stderr only.

## Account-Owned Creation

With an authoring-capable `ND_AUTH_FILE`, `drop_create` seals a delegated account-owned envelope by default. Its `visibility` input accepts `private`, `unlisted`, or `public` and defaults to `unlisted`; public and unlisted envelopes use the public-only `VITE_PROVIDER_ENCRYPTION_PUBLIC_JWK` escrow configuration. Never set that variable to a private JWK.

An older auth file without local authoring material fails deterministically with a request to run `nd auth login` again. `ND_TOKEN` alone is not authoring authority and receives the same error. For a deliberate legacy plaintext write, set `legacyPlaintext: true`; MCP emits a stderr warning and the resulting authenticated plaintext drop will not enter Remote Library.

For an exact `diff_apply` retry, provide `eventId` and `createdAt` together with
the original operations and metadata. The tool rejects partial identities before
network I/O and treats a missing or mismatched acknowledgement as unconfirmed.

## Tool Groups

| Group | Purpose |
| --- | --- |
| Drop tools | Read and inspect persisted Nulldown documents. |
| Branch tools | Resolve a branch, fetch exact branch content, query resolved structure, and apply diff events. |
| Memory tools | Query freshness-aware NullMem facts and procedures, then record reusable verified knowledge. |
| Strategy tools | Read Nulldown-hosted strategy and documentation drops. |

Use `branch_query` before `branch_content` whenever possible. Queries return structural nodes with source ranges and ranking context; fetch exact content only when an edit, claim, or decision requires it.

## Response Discipline

Read/query tools use compact responses by default and accept response controls where supported:

| Input | Meaning |
| --- | --- |
| `preview` | Request compact preview behavior. |
| `maxTokens` | Set an approximate response budget. |
| `format` | Choose `compact` or `full` serialization. |

Compactness is a transport guard, not a substitute for correct retrieval. Agents should query the relevant branch/heap first, check freshness for memory used as current-work guidance, and expand exact sources only when needed.

## Learn More

- [Nulldown documentation](https://nulldown.app/d/vjdL1x)
- [Deterministic structure for Markdown](https://nulldown.app/d/q2BylK)
- [Agents, retrieval, and memory](https://nulldown.app/d/TwPp4l)
- [Build with Nulldown](https://nulldown.app/d/hCPw9B)

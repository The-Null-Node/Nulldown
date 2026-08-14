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
        "ND_ACCOUNT_ID": "<account-id>",
        "ND_CLIENT_ID": "<stable-client-id>"
      }
    }
  }
}
```

Add `ND_TOKEN` when the target API requires a bearer session. Protected diff writes may also require `ND_DIFF_AUTH_TOKEN`, exported with `nd diff token export`; `DIFF_WEBHOOK_SECRET` is supported for webhook-style signing.

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

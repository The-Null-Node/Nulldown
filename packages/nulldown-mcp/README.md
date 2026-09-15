# @thenullnode/nulldown-mcp

`@thenullnode/nulldown-mcp` is the stdio MCP server for Nulldown's deterministic Markdown structure. It gives agents structured access to drops, branches, diff events, resolved queries, and NullMem without requiring shell commands.

Nulldown turns Markdown into deterministic structure. This server lets an MCP client retrieve the smallest relevant branch structure, follow source references, apply attributable diffs, and retain reusable facts or procedures near their evidence.

## Install

This checkout prepares unpublished MCP `0.0.8`, requiring core
`>=0.0.8 <0.1.0`. Verify the candidate with both local tarballs; the registry
command below does not install this unpublished pair.

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

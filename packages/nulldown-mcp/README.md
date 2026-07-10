# @thenullnode/nulldown-mcp

Stdio MCP server for Nulldown API, branch, diff, and NullMem tools.

Run from a checkout:

```bash
bun run bin/nulldown-mcp.ts
```

Run after installing the package:

```bash
nulldown-mcp
```

Configure the server with `ND_BASE_URL`, `ND_TOKEN`, `ND_ACCOUNT_ID`, and `ND_CLIENT_ID` in the MCP client environment. For protected diff writes, export an `ND_DIFF_AUTH_TOKEN` from `nd diff token export`; `DIFF_WEBHOOK_SECRET` is also supported for webhook-style signing.

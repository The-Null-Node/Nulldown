---
name: nulldown-mcp-skill
description: Operates Nulldown through direct MCP tools. Use for agent reads, queries, branch edits, memory, and strategy retrieval when Nulldown MCP is available; do not shell out to nd.
---

# Nulldown MCP

Use direct `strategy_*`, `drop_*`, `branch_*`, `memory_*`, and `diff_apply`
tools. Never shell out to `nd` unless the user explicitly requests CLI guidance
or the required capability is absent from MCP.

Compact and preview responses are transport formats, not user-facing prose.
Translate results into direct explanations and retrieve full content only when
exact text or edit offsets are required.

## Hosted Strategy

Canonical strategy: https://nulldown.app/d/6656xJ

Load root `6656xJ0oco1n` with `strategy_get` before applying this skill. Follow
the drop-owned `metadata.strategyRef` when present and retain the returned
branch/snapshot identity as evidence, not as public copy.

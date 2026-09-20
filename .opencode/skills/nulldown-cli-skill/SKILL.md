---
name: nulldown-cli-skill
description: Operates Nulldown through the nd CLI. Use for terminal automation, CLI-specific authentication or recovery, CLI smoke tests, and operations that MCP does not expose.
---

# Nulldown CLI

Use `nd` only after the CLI surface is selected. Keep commands machine-readable
with `--json` when another agent consumes the result. Do not copy CLI-only
authentication, configuration, or recovery steps into MCP guidance.

## Hosted Strategy

Canonical strategy: https://nulldown.app/d/oTnTI2

Load root `oTnTI2MIbQvS` with `strategy_get` before applying this skill. Follow
the drop-owned `metadata.strategyRef` when present.

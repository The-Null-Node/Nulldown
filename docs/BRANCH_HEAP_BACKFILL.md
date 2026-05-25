# Branch Heap Backfill Runbook

This runbook migrates branch state to snapshot heap v2 in safe batches.

## Prerequisites

Backfill endpoint deployed: `POST /api/branches/backfill/:id`

- Env var set in deployment: `BRANCH_HEAP_BACKFILL_TOKEN`
- Local shell token export:

```bash
export BRANCH_HEAP_BACKFILL_TOKEN="<strong-random-token>"
```

## One-shot backfill

```bash
bun run branch:backfill --drop <rootDropId>
```

## Controlled batch run

```bash
bun run branch:backfill \
  --drop <rootDropId> \
  --limit 200 \
  --max-batches 20 \
  --max-retries 5 \
  --retry-ms 800
```

## Resume from cursor

If output ends with `nextCursor=<value>`, resume with:

```bash
bun run branch:backfill --drop <rootDropId> --cursor <nextCursor>
```

## Against non-local base URL

```bash
bun run branch:backfill --drop <rootDropId> --base https://your-app.pages.dev
```

## What the script prints

- Per batch: current cursor, next cursor, scanned, migrated, already-v2, missing, failed
- Final totals: aggregate counts and resumable `nextCursor`

## Safety notes

- The endpoint is idempotent for already migrated branches.
- Use a small `--limit` first in production to validate behavior.
- Keep `BRANCH_HEAP_BACKFILL_TOKEN` out of shell history in shared environments.

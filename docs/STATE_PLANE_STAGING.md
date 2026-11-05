# State Plane staging

The experimental State Plane stores branch state in SQLite-backed Durable
Objects. Its staging API reuses the application's HTTP handlers with a private
Worker service binding. Each staging deployment has its own D1 database, R2
bucket, Durable Object namespace, and provider keys.

## Configuration

The configurations live in `packages/nulldown-state-plane/`:

- `wrangler.staging.jsonc` deploys the private State Plane Worker and creates its
  SQLite-backed Durable Object class. Both workers.dev and preview URLs are
  disabled. `OUTBOX_QUEUE`, `OUTBOX_ARCHIVE`, and `OUTBOX_DB` select a dedicated
  delivery queue, encrypted archive bucket, and metadata projection database.
- `wrangler.api-staging.jsonc` deploys the HTTP API. Its `STATE_PLANE` service
  binding selects the private Worker's `BranchStateService` entrypoint. `DB` and
  `R2_BUCKET` select staging storage.

The checked-in resource identifiers belong to this repository's staging
environment. For another account, create separate resources and update those
identifiers before deploying. The production Pages configuration is
`wrangler.toml`.

## Deploy

From the repository root, apply the application schema to the staging database:

```bash
bunx wrangler d1 migrations apply nulldown-state-plane-staging --remote \
  --config packages/nulldown-state-plane/wrangler.api-staging.jsonc
```

Apply the separate projection schema and configure the archive key:

```bash
bunx wrangler d1 migrations apply nulldown-state-plane-projections-staging --remote \
  --config packages/nulldown-state-plane/wrangler.staging.jsonc
bunx wrangler secret put OUTBOX_ARCHIVE_KEY \
  --config packages/nulldown-state-plane/wrangler.staging.jsonc
```

`OUTBOX_ARCHIVE_KEY` is a base64-encoded random 32-byte AES-256-GCM key.
`OUTBOX_ARCHIVE_KEY_ID` identifies that key in archive envelopes. Preserve the
key securely so archived records remain decryptable.

Deploy the private service first:

```bash
bunx wrangler deploy \
  --config packages/nulldown-state-plane/wrangler.staging.jsonc
```

Configure fresh API secrets with Wrangler's interactive prompts:

```bash
bunx wrangler secret put ACCOUNT_AUTH_SECRET \
  --config packages/nulldown-state-plane/wrangler.api-staging.jsonc
bunx wrangler secret put PROVIDER_ENCRYPTION_PRIVATE_JWK \
  --config packages/nulldown-state-plane/wrangler.api-staging.jsonc
bunx wrangler secret put PROVIDER_SIGNING_PRIVATE_JWK \
  --config packages/nulldown-state-plane/wrangler.api-staging.jsonc
```

Use a random session-signing secret, an RSA-OAEP/SHA-256 provider encryption JWK,
and an ECDSA P-256 provider signing JWK. Clients use the public encryption key
for authoring and the public signing key for verification. Keep private keys and
credentials outside the checkout.

Then deploy the API:

```bash
bunx wrangler deploy \
  --config packages/nulldown-state-plane/wrangler.api-staging.jsonc
```

Use the API URL printed by Wrangler as the client base URL. Account sessions use
the existing signed-key proof flow at `POST /api/auth/session`; the API verifies
the proof, persists the account, and issues a signed bearer token. Account-header
authentication is disabled. This API deployment does not include the browser
application or its OpenAuth login flow.

## Exercise the hosted API

Build the CLI and inspect the acceptance runner's arguments:

```bash
bun run cli:build
bun --no-env-file run scripts/state-plane/staging-acceptance.ts --help
```

The runner has three modes:

1. `prepare` generates fresh client identities locally. Supply a public-key JSON
   file with `providerEncryptionPublicJwk` and `providerSigningPublicJwk`.
2. `run` registers those identities through the API and exercises authenticated
   SDK, MCP, and compiled CLI operations, including rejection and retry paths.
3. `verify-after-redeploy` checks the same accepted state after redeploying the
   private Worker. Supply the new deployment version and the same client directory.

Use a private client directory outside the checkout and a new evidence directory
for every invocation. The runner enforces private file permissions and preserves
earlier runs. A failed `run` also consumes its identity set; prepare a fresh set
for another run. Start log collection before the hosted requests, and correlate
the evidence's request identifiers with retained API events.

For query and delivery testing on a fresh account clone of the configured synthetic
public root, run `bun --no-env-file run scripts/state-plane/hosted-query-outbox-acceptance.ts --help`.
This runner leaves the root and owner branch untouched and supports a separate
post-redeploy readback. It tests SDK, MCP, and compiled CLI queries; archive and
projection verification is performed separately. It does not test root creation.

## Storage and migration

Selected document queries build an ephemeral resolved heap from an exact
authoritative snapshot. They do not require the asynchronous D1 projection or
an R2 resolved heap. Queries use intrinsic document and event scoring; explicit
priority-fact operations and persistent heap updates are unsupported on selected
authority. Other resolver domains require their own selected capability.

Outbox delivery uses expiring durable claims and reference-only Queue messages.
Consumers seal immutable artifacts before writing them to R2 and persist derived
metadata in the separate D1 database before acknowledging delivery. A minute
cron revisits the fixed shard pool to recover missed wakeups. Delivery is enabled
by `STATE_PLANE_OUTBOX_ENABLED="1"` in the staging configuration.

Retention compacts completed delivery bookkeeping. Canonical outbox records,
receipts, and authoritative history remain available as integrity witnesses;
this is not an archive or document-history deletion policy.

D1 migrations create the account and metadata schema. The Worker's `v1`
migration creates the Durable Object class. Neither operation imports existing
branch data.

Use fresh signed roots in this environment. Production branches continue using
their existing backend. The synthetic rehearsal below is separate from the
application API; production cutover still requires an admission gate covering
every legacy writer and a deployment-specific authority controller.

Existing branches will need a consistent import, verification, and a fenced
change of authority. Once the new backend has accepted writes, returning to the
old backend also requires transferring those changes; changing routing alone
would lose accepted work.

## Synthetic migration rehearsal and benchmarks

Run the local tools from the repository root:

```bash
bun run test:state-plane:migration --evidence=/path/to/fresh/rehearsal-results
bun run bench:state-plane --evidence=/path/to/fresh/benchmark-results
```

Both tools use Miniflare with synthetic storage. Evidence directories must be
fresh. Keep the reports and raw samples together: latency depends on workload,
runtime, concurrency, and which boundaries the measurement includes.

[`source-fence.ts`](../src/server/state-plane/source-fence.ts) records writer
admissions durably. Freezing a source stops new
admissions and waits for admitted mutations to settle. An uncertain admission
does not expire automatically.
[`legacy-migration-source.ts`](../src/server/state-plane/legacy-migration-source.ts) captures the frozen
history, runtime facts, and branch-local memory; unsupported capabilities reject
explicitly. Global persisted memory defaults and priority facts are outside this
import envelope.

[`sqlite-migration.ts`](../src/server/state-plane/sqlite-migration.ts) stages
hashed chunks before publishing destination state.
Pre-transfer rollback reopens the source at a new generation. Source transfer is
irreversible: an uncertain activation must recover forward, and accepted
destination writes cannot be discarded by switching back to legacy routing.

For an isolated hosted rehearsal, `wrangler.migration-rehearsal.jsonc` selects a
separate Worker, SQLite Durable Object namespace, R2 bucket, and D1 database.
The gateway requires `MIGRATION_REHEARSAL_TOKEN`. Configure it through Wrangler's
secret prompt; keep the runner's credential file outside the checkout. The
gateway accepts only synthetic rehearsal operations.

## Logs

Both Workers enable Workers Logs at full sampling. Automatic tracing is disabled:
Cloudflare's SQL trace attributes can include bound values. Application summaries
and request-scoped RPC timings provide bounded metadata instead.

In Cloudflare Dashboard, open **Workers & Pages → nulldown-state-plane-api-staging
→ Observability → Logs**. Existing production completion events are stored under
the separate `nulldown-telemetry` Worker.

Capture API logs with:

```bash
bunx wrangler tail nulldown-state-plane-api-staging --format json \
  --config packages/nulldown-state-plane/wrangler.api-staging.jsonc
```

Use request and operation identifiers to correlate `http.complete` summaries
with `state_plane.rpc` events. RPC timings cover the gateway service boundary;
they do not measure DO-internal SQL execution. A live tail can be incomplete, so
verify journal coverage against retained Workers Logs. Retention follows the
Cloudflare account's Workers Logs limits. Redeployment followed by readback
checks persistence across deployments; it does not establish individual-object
eviction or power-loss recovery.

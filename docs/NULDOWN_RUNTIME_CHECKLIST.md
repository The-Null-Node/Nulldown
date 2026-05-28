# Nulldown Runtime Implementation Checklist

Parent tracker: [NullProvider, Nullplug, Snapshotter, And Null.Call](https://nulldown.app/d/Nr3hhv)

Expanded tracker branch: `rootDropId=Nr3hhveS67B5`, `branchId=clone_anonymous`

## Planning Chain

- [Runtime checklist](https://nulldown.app/d/aN8B4B)
- [Native `nd` nullplug](https://nulldown.app/d/vF8P56)
- [Diff metadata and batches](https://nulldown.app/d/fWbXBu)
- [Resolved heaps and context tokens](https://nulldown.app/d/hB70BJ)
- [Snapshot sidecars](https://nulldown.app/d/k37nUG)
- [Atomic UI nullplugs](https://nulldown.app/d/emEFnm)
- [Runtime policy and conditional grants](https://nulldown.app/d/I1FGwa)
- [Nullplug runtime wrapper](https://nulldown.app/d/mAJODb)
- [NullProvider runtime](https://nulldown.app/d/H2oXJR)
- [Registry and security](https://nulldown.app/d/gEoo2y)
- [Null.Call, streams, NullMem](https://nulldown.app/d/sovZAf)

## Phase 1: Native `nd` Nullplug

- [x] Implement client-side `nd` plugin card mode.
- [x] Support `nd(id="...")` fence args.
- [x] Support body syntax.
- [x] Render compact card by default.
- [x] Avoid iframe embedding for Nulldown drops.
- [x] Add initial shared nullplug call/result contracts.
- [x] Update parent tracker to reference this checklist.
- [x] Mark native `nd` plan status as implemented.
- [x] Resolve default mode decision as card mode.
- [ ] Update parent and planning drops to use native `nd` blocks where useful.
- [ ] Add stronger explicit cycle/provenance guard before inline mode.

## Phase 2: Diff Metadata

- [x] Add `DropDiffEvent.metadata`.
- [x] Add `DropDiffEventMetadata` type.
- [x] Add event kinds for `ui.response` and `policy.decision`.
- [x] Update Zod diff schemas.
- [x] Preserve metadata through diff API append.
- [x] Carry metadata through local/remote diff channels.
- [x] Add tests for metadata validation and replay safety.

## Phase 3: CLI Metadata And Batches

- [x] Add `nd diff apply --metadata-file`.
- [x] Add `nd diff replace --metadata-file`.
- [x] Add `nd diff batch`.
- [x] Document `nullplug.invoke`, `ui.response`, and `policy.decision` metadata examples.
- [x] Verify posted metadata survives diff polling.
- [x] Verify batched events preserve order and metadata through diff polling.

## Phase 4: Resolved Heaps And Context Tokens

- [x] Define `ndctx.v1.<base64url-json>` context token.
- [x] Add source hash helper for markdown payloads and branch snapshots.
- [x] Add resolved heap record types.
- [x] Add resolved checklist parser/heapifier.
- [x] Add query helper for next unchecked important item.
- [x] Add general document heap and top-k node query.
- [x] Add branch resolved query endpoint and CLI command.
- [x] Store resolver id/version and source provenance on resolved heap records.
- [ ] Add stale-heap fallback to raw markdown fetch.

## Phase 5: Sidecars And Observers

- [x] Add event metadata sidecar helpers.
- [x] Add snapshot metadata sidecar helpers.
- [x] Add resolved heap storage helpers.
- [x] Add branch append observer hooks after primary write success.
- [x] Keep primary replay independent from sidecars and resolved heaps.
- [ ] Add idempotent sidecar write tests.

## Phase 6: Atomic UI Nullplugs

- [x] Add normalized `mutations` and `yields` to `NullplugResult`.
- [x] Define yield kinds for UI response, policy decision, stream event, and agent note.
- [x] Add form/action/card nullplug primitives.
- [x] Add submit endpoint or provider method for atomic UI response facts.
- [x] Store response facts as sidecars or resolved heap facts.
- [x] Let responses carry optional proposed diffs.
- [x] Add stream descriptors for long-running agent/plugin output.

## Phase 7: Runtime Policy And Conditional Grants

- [x] Define root runtime policy metadata shape.
- [x] Normalize `allowedUrls` into `runtimePolicy.network.allowedHosts` without breaking existing docs.
- [x] Add conditional grant types.
- [x] Add callable policy evaluator adapter.
- [x] Add max-grant validation.
- [x] Add policy decision yield type.
- [ ] Add audit sidecar for policy decisions.
- [x] Add tests for deny-by-default and max-grant enforcement.

## Phase 8: Nullplug Runtime Wrapper

- [ ] Introduce `NullplugRuntime` wrapper.
- [x] Add adapter from current `NullplugHandler` return type to `NullplugResult`.
- [x] Add remote invoke DTOs.
- [x] Add root policy validation hook.
- [x] Add mutation normalization and downgrade rules.
- [x] Add diagnostics handling.
- [x] Add tests for built-in, remote-shaped, and policy-shaped returns.

## Phase 9: Provider Runtime

- [ ] Create `NullProvider` wrapper shape.
- [ ] Keep `DropProviderPort` as a child storage/sync capability under `VoidProvider`.
- [x] Add provider-level nullplug resolver boundary.
- [ ] Add provider policy service boundary.
- [x] Decide `/api/nullplug/resolve` vs `/api/render/:id`.

## Phase 10: Registry And Future Runtime

- [x] Add remote nullplug manifest model.
- [x] Add allowlist-gated registry storage.
- [x] Define capability tokens and permissions.
- [x] Add `policy.evaluate` capability.
- [x] Add registry HTTP endpoints with account auth.
- [x] Add manifest signature verification.
- [ ] Defer trusted package plugins until remote HTTP plugins work.
- [ ] Defer full `null.call`, streams, and `NullMem` until metadata/sidecars/resolved heaps stabilize.

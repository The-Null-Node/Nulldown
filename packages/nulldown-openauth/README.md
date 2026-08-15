# Nulldown OpenAuth Worker Foundation

This package is a provider-neutral implementation and test foundation for Slice 2. It is **not** a production sign-in deployment: it has no email-sending domain, delivery implementation, identity store, client registration, or Worker configuration committed to the repository.

The Worker accepts only OAuth authorization-code requests with S256 PKCE, an opaque client-generated `state`, and one exact registered HTTPS redirect URI per client ID. It issues only the versioned `nulldown-user` principal containing `version` and `userId`. It does not receive legacy account IDs, vault material, OAuth tokens, recovery data, or provider email in that principal.

OpenAuth `0.4.3` is pinned for the issuer, Cloudflare KV storage adapter, authorization-code exchange, PKCE validation, token signing, and token verification. Its published issuer imports unused AWS-Lambda and environment-selected storage paths, enables request logging, and its `CodeProvider` imports `node:crypto`; neither can bundle for a Web-APIs-only Worker and the logger would emit authorization URLs. The package carries a narrow Bun patch to remove those imports and logger, plus the smallest equivalent adapter for the provider's start/request/verify state flow, unbiased code generation, timing-safe comparison, and injected delivery callback. It does not implement OAuth or token handling itself.

## Required deployment prerequisites

Create a local, uncommitted Worker configuration with all of the following real resources before invoking `bun run deploy`:

- A KV namespace bound as `OPENAUTH_KV` for OpenAuth signing keys, encrypted flow cookies, authorization codes, and refresh-token state.
- A service binding or equivalent RPC adapter bound as `OPENAUTH_CODE_DELIVERY` that implements `sendCode({ address, code })`. No Cloudflare Email Sending configuration exists yet.
- A service binding bound as `OPENAUTH_IDENTITY_RESOLVER` that implements `resolveUserId({ address })` against application-owned user and identity data. It must return a stable internal `userId` and must not give the Worker vault or legacy-account authority.
- A non-secret `OPENAUTH_CLIENTS_JSON` Worker variable containing one or more exact canonical HTTPS `{ clientId, redirectUri }` registrations. Wildcards, same-domain matching, HTTP callbacks, credentials, fragments, and non-canonical URLs are rejected.

The package deliberately has no committed `wrangler` config: a KV namespace binding cannot be valid without a provisioned namespace ID, and a delivery/identity service cannot be valid without deployed application services. `bun run deploy` fails until `NULDOWN_OPENAUTH_WRANGLER_CONFIG` points to a local config that declares all three bindings. Local configs are ignored by this package. Do not add secrets to the Worker config, source, or repository.

## Downstream BFF contract

The later BFF and migration slice must generate and persist its own authorization `state`, redirect to this Worker with a registered client ID and S256 PKCE challenge, compare the returned state exactly before exchanging the code, and keep access/refresh credentials in secure HTTP-only cookies. It must verify issuer, audience, expiry, and the strict `nulldown-user` v1 principal before mapping `userId` to application authorization. Legacy `ndacc.v1` account sessions remain independent.

Run `bun run test` and `bun run check` from this package for the focused foundation checks.

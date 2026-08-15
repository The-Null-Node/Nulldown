# Nulldown OpenAuth Worker Foundation

This package is a provider-neutral implementation and test foundation for Slice 2. Its Worker adapter uses native Cloudflare KV, D1, and Email Sending bindings, but it has no committed deployment resources or Worker configuration.

The Worker accepts only OAuth authorization-code requests with S256 PKCE, an opaque client-generated `state`, and one exact registered HTTPS redirect URI per client ID. It issues only the versioned `nulldown-user` principal containing `version` and `userId`. It does not receive legacy account IDs, vault material, OAuth tokens, recovery data, or provider email in that principal.

OpenAuth `0.4.3` is pinned for the issuer, Cloudflare KV storage adapter, authorization-code exchange, PKCE validation, token signing, and token verification. Its published issuer imports unused AWS-Lambda and environment-selected storage paths, enables request logging, and its `CodeProvider` imports `node:crypto`; neither can bundle for a Web-APIs-only Worker and the logger would emit authorization URLs. The package carries a narrow Bun patch to remove those imports and logger, plus the smallest equivalent adapter for the provider's start/request/verify state flow, unbiased code generation, timing-safe comparison, and injected delivery callback. It does not implement OAuth or token handling itself.

## Required deployment prerequisites

Create a local, uncommitted Worker configuration with all of the following real resources before invoking `bun run deploy`:

- A KV namespace bound as `OPENAUTH_KV` for OpenAuth signing keys, encrypted flow cookies, authorization codes, refresh-token state, and short hashed-address code-delivery cooldowns.
- The shared D1 database bound as `DB`, with additive `auth_users` and `auth_external_identities` tables from migration `0009_openauth_principals.sql`. The Worker creates an opaque internal user ID only for a verified normalized email and never reads or writes legacy account authority.
- A Cloudflare Email Sending binding named `EMAIL`, with the sender domain onboarded and a binding restriction appropriate for the configured sender. The adapter calls `EMAIL.send()` directly with plaintext and HTML code messages; it uses no email API key or REST request.
- A non-secret canonical HTTPS `OPENAUTH_ISSUER_URL` origin and `OPENAUTH_EMAIL_FROM` sender address. The Worker rejects paths, credentials, fragments, non-HTTPS origins, and invalid sender addresses.
- A non-secret `OPENAUTH_CLIENTS_JSON` Worker variable containing one or more exact canonical HTTPS `{ clientId, redirectUri }` registrations. Wildcards, same-domain matching, HTTP callbacks, credentials, fragments, and non-canonical URLs are rejected.

The package deliberately has no committed `wrangler` config: KV and D1 resource IDs plus sender-domain setup are deployment-specific. `bun run deploy` fails until `NULDOWN_OPENAUTH_WRANGLER_CONFIG` points to a local config that declares the native bindings and variables above. Local configs are ignored by this package. Do not add secrets to the Worker config, source, or repository.

## Downstream BFF contract

The BFF generates and persists its own authorization `state`, redirects to this Worker with a registered client ID and S256 PKCE challenge, compares the returned state exactly before exchanging the code, and keeps access/refresh credentials in secure HTTP-only cookies. It verifies issuer, audience, expiry, and the strict `nulldown-user` v1 principal, then confirms that user ID exists in the shared `auth_users` table without creating records from token data. Legacy `ndacc.v1` account sessions remain independent.

Run `bun run test` and `bun run check` from this package for the focused foundation checks.

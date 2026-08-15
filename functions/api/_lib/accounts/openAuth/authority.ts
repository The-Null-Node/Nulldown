import { createClient } from "@openauthjs/openauth/client";

import {
  NULDOWN_USER_SUBJECT_TYPE,
  parseNulldownUserPrincipal,
  parseNulldownUserSubject,
  type NulldownUserPrincipalV1,
} from "../../../../../shared/auth/subjects";

const CONFIG_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

/** Minimal service-binding Fetch surface accepted by the Pages BFF. */
export interface OpenAuthAuthorityFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** Deployment-provided authority settings. No authority or email resources are configured here. */
export interface OpenAuthAuthorityEnvironment {
  /** Exact canonical HTTPS issuer URL that signs OpenAuth access tokens. */
  OPENAUTH_ISSUER_URL?: string;
  /** Exact registered OpenAuth browser client id. */
  OPENAUTH_CLIENT_ID?: string;
  /** Exact audience expected in every OpenAuth access token. */
  OPENAUTH_AUDIENCE?: string;
  /** Optional service binding used instead of public network fetches to the issuer. */
  OPENAUTH_AUTHORITY?: OpenAuthAuthorityFetcher;
}

/** Values required to begin a single authorization-code PKCE flow. */
export interface OpenAuthAuthorizationRequest {
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}

/** Tokens received from the authority after a valid authorization-code exchange. */
export interface OpenAuthTokens {
  access: string;
  refresh: string;
  expiresIn: number;
}

/** Verified OpenAuth principal and its canonical issuer. */
export interface VerifiedOpenAuthPrincipal {
  issuer: string;
  principal: NulldownUserPrincipalV1;
}

/** Narrow BFF port. It never adapts OpenAuth credentials into legacy bearer headers. */
export interface OpenAuthAuthority {
  createAuthorizationUrl(input: OpenAuthAuthorizationRequest): string;
  exchangeAuthorizationCode(input: Readonly<{
    code: string;
    redirectUri: string;
    verifier: string;
  }>): Promise<OpenAuthTokens | null>;
  verifyAccessToken(accessToken: string): Promise<VerifiedOpenAuthPrincipal | null>;
}

const normalizeIssuer = (value: string | undefined): string | null => {
  if (!value) return null;

  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
};

const normalizeToken = (value: string | undefined): string | null =>
  value && CONFIG_TOKEN_PATTERN.test(value) ? value : null;

const isTokens = (value: unknown): value is OpenAuthTokens => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.access === "string" &&
    record.access.length > 0 &&
    typeof record.refresh === "string" &&
    record.refresh.length > 0 &&
    typeof record.expiresIn === "number" &&
    Number.isFinite(record.expiresIn) &&
    record.expiresIn > 0
  );
};

const openAuthSubjects = {
  [NULDOWN_USER_SUBJECT_TYPE]: {
    "~standard": {
      validate: async (value: unknown) => {
        const parsed = parseNulldownUserSubject(value);
        return parsed
          ? { value: parsed }
          : { issues: [{ message: "Invalid nulldown-user subject." }] };
      },
    },
  },
};

/** Builds the authority adapter from deployment configuration, or returns null to fail closed. */
export const createOpenAuthAuthority = (
  env: OpenAuthAuthorityEnvironment,
): OpenAuthAuthority | null => {
  const issuer = normalizeIssuer(env.OPENAUTH_ISSUER_URL);
  const clientId = normalizeToken(env.OPENAUTH_CLIENT_ID);
  const audience = normalizeToken(env.OPENAUTH_AUDIENCE);
  if (!issuer || !clientId || !audience) return null;

  // A future Pages deployment may bind the separately deployed issuer as OPENAUTH_AUTHORITY.
  // Without that binding, this adapter uses the configured canonical issuer URL directly.
  const authorityFetch = env.OPENAUTH_AUTHORITY
    ? (input: RequestInfo | URL, init?: RequestInit) =>
        env.OPENAUTH_AUTHORITY!.fetch(input, init)
    : fetch;
  const client = createClient({
    clientID: clientId,
    issuer,
    fetch: authorityFetch,
  });

  return {
    createAuthorizationUrl(input) {
      const url = new URL("/authorize", issuer);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", input.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("state", input.state);
      url.searchParams.set("nonce", input.nonce);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("code_challenge", input.codeChallenge);
      return url.toString();
    },
    async exchangeAuthorizationCode(input) {
      const exchanged = await client.exchange(input.code, input.redirectUri, input.verifier);
      return exchanged.err ? null : isTokens(exchanged.tokens) ? exchanged.tokens : null;
    },
    async verifyAccessToken(accessToken) {
      const verified = await client.verify(openAuthSubjects as never, accessToken);
      if ("err" in verified || verified.aud !== audience) return null;

      const principal = parseNulldownUserPrincipal(verified.subject);
      return principal ? { issuer, principal } : null;
    },
  };
};

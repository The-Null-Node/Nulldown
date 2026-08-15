import type { D1Database } from "@cloudflare/workers-types";

import {
  appendOpenAuthSessionClearCookies,
  appendOpenAuthSessionCookies,
  appendOpenAuthTransactionClearCookie,
  appendOpenAuthTransactionCookie,
  readOpenAuthAccessCookie,
  readOpenAuthRefreshCookie,
  readOpenAuthTransactionCookie,
} from "./cookies";
import {
  createOpenAuthAuthority,
  type OpenAuthAuthority,
  type OpenAuthAuthorityEnvironment,
} from "./authority";
import { readOpenAuthUser } from "./principals";
import {
  consumeOpenAuthCallbackTransaction,
  createOpenAuthCallbackTransaction,
} from "./transactions";

const CALLBACK_PATH = "/api/auth/open/callback";
const TRANSACTION_TTL_SECONDS = 10 * 60;

/** Environment bindings used only by the isolated OpenAuth Pages BFF. */
export interface OpenAuthBffEnvironment extends OpenAuthAuthorityEnvironment {
  DB?: D1Database;
  /** Exact canonical external Pages origin later registered as the OpenAuth callback origin. */
  OPENAUTH_BFF_ORIGIN?: string;
}

interface OpenAuthBffConfig {
  db: D1Database;
  authority: OpenAuthAuthority;
  origin: string;
  callbackUri: string;
}

const textEncoder = new TextEncoder();

const responseJson = (body: unknown, status: number, headers?: HeadersInit): Response => {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json");
  responseHeaders.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
};

const unavailable = (reason: string): Response =>
  responseJson({ error: "open_auth_unavailable", reason }, 503);

const normalizeOrigin = (value: string | undefined): string | null => {
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

const resolveConfig = (
  env: OpenAuthBffEnvironment,
  request: Request,
): OpenAuthBffConfig | Response => {
  const authority = createOpenAuthAuthority(env);
  if (!authority) return unavailable("authority_configuration_missing");
  if (!env.DB) return unavailable("d1_binding_missing");

  const origin = normalizeOrigin(env.OPENAUTH_BFF_ORIGIN);
  if (!origin || origin !== new URL(request.url).origin) {
    return unavailable("bff_origin_configuration_missing");
  }

  return { db: env.DB, authority, origin, callbackUri: `${origin}${CALLBACK_PATH}` };
};

const isConfig = (value: OpenAuthBffConfig | Response): value is OpenAuthBffConfig =>
  !(value instanceof Response);

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const randomToken = (bytesLength: number): string =>
  toBase64Url(crypto.getRandomValues(new Uint8Array(bytesLength)));

const hashState = async (state: string): Promise<string> =>
  toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(state))));

const timingSafeEqual = (left: string, right: string): boolean => {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const maxLength = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < maxLength; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
};

const parseReturnTo = (value: string | null, origin: string): string | null => {
  if (value === null) return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return null;

  try {
    const resolved = new URL(value, origin);
    if (resolved.origin !== origin) return null;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return null;
  }
};

const callbackError = (error: string, status: number): Response => {
  const headers = new Headers();
  appendOpenAuthTransactionClearCookie(headers);
  return responseJson({ error }, status, headers);
};

const callbackRedirect = (location: string): Response => {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  return new Response(null, { status: 302, headers });
};

const sameOriginLogoutRequest = (request: Request): boolean => {
  const origin = new URL(request.url).origin;
  const requestOrigin = request.headers.get("Origin");
  if (requestOrigin !== null) return requestOrigin === origin;

  const referer = request.headers.get("Referer");
  if (!referer) return false;
  try {
    return new URL(referer).origin === origin;
  } catch {
    return false;
  }
};

/** Starts an authorization-code PKCE flow without persisting browser-readable credentials. */
export const startOpenAuthLogin = async (
  env: OpenAuthBffEnvironment,
  request: Request,
): Promise<Response> => {
  const config = resolveConfig(env, request);
  if (!isConfig(config)) return config;

  const returnTo = parseReturnTo(new URL(request.url).searchParams.get("returnTo"), config.origin);
  if (!returnTo) return responseJson({ error: "invalid_return_to" }, 400);

  const nonce = randomToken(32);
  // The fixed-width nonce prefix lets the callback verify nonce and state without persisting either.
  const state = `${nonce}${randomToken(32)}`;
  const verifier = randomToken(48);
  const codeChallenge = await hashState(verifier);
  try {
    await createOpenAuthCallbackTransaction(config.db, {
      stateHash: await hashState(state),
      returnTo,
      expiresAt: Date.now() + TRANSACTION_TTL_SECONDS * 1000,
    });
  } catch {
    return unavailable("callback_transaction_unavailable");
  }

  const response = callbackRedirect(
    config.authority.createAuthorizationUrl({
      redirectUri: config.callbackUri,
      state,
      nonce,
      codeChallenge,
    }),
  );
  appendOpenAuthTransactionCookie(response.headers, { state, nonce, verifier }, TRANSACTION_TTL_SECONDS);
  return response;
};

/** Consumes the one-time transaction, exchanges its code, and establishes BFF-only cookies. */
export const completeOpenAuthCallback = async (
  env: OpenAuthBffEnvironment,
  request: Request,
): Promise<Response> => {
  const config = resolveConfig(env, request);
  if (!isConfig(config)) return config;

  const callback = new URL(request.url);
  const code = callback.searchParams.get("code");
  const returnedState = callback.searchParams.get("state");
  const transaction = readOpenAuthTransactionCookie(request);
  if (!code || !returnedState || !transaction || !transaction.verifier) {
    return callbackError("invalid_callback", 400);
  }

  const nonceMatches = timingSafeEqual(
    returnedState.slice(0, transaction.nonce.length),
    transaction.nonce,
  );
  if (!nonceMatches || !timingSafeEqual(returnedState, transaction.state)) {
    return callbackError("invalid_callback", 400);
  }

  let returnTo: string | null;
  try {
    returnTo = await consumeOpenAuthCallbackTransaction(
      config.db,
      await hashState(returnedState),
    );
  } catch {
    return callbackError("callback_transaction_unavailable", 503);
  }
  if (!returnTo) return callbackError("invalid_callback", 400);

  let tokens;
  try {
    tokens = await config.authority.exchangeAuthorizationCode({
      code,
      redirectUri: config.callbackUri,
      verifier: transaction.verifier,
    });
  } catch {
    return callbackError("authority_unavailable", 503);
  }
  if (!tokens) return callbackError("invalid_authorization_code", 401);

  let verified;
  try {
    verified = await config.authority.verifyAccessToken(tokens.access);
  } catch {
    return callbackError("authority_unavailable", 503);
  }
  if (!verified) return callbackError("invalid_access_token", 401);

  try {
    if (!(await readOpenAuthUser(config.db, verified))) {
      return callbackError("invalid_principal", 401);
    }
  } catch {
    return callbackError("principal_store_unavailable", 503);
  }

  const response = callbackRedirect(returnTo);
  appendOpenAuthSessionCookies(response.headers, tokens);
  appendOpenAuthTransactionClearCookie(response.headers);
  return response;
};

/** Returns only the minimal application principal and never returns OpenAuth credentials. */
export const readOpenAuthPrincipal = async (
  env: OpenAuthBffEnvironment,
  request: Request,
): Promise<Response> => {
  const config = resolveConfig(env, request);
  if (!isConfig(config)) return config;

  const accessToken = readOpenAuthAccessCookie(request);
  if (!accessToken) return responseJson({ authenticated: false }, 200);
  const refreshToken = readOpenAuthRefreshCookie(request);

  try {
    const verified = await config.authority.verifyAccessToken(accessToken, refreshToken ?? undefined);
    const userId = verified ? await readOpenAuthUser(config.db, verified) : null;
    if (userId) {
      const headers = new Headers();
      if (verified?.refreshedTokens) {
        appendOpenAuthSessionCookies(headers, verified.refreshedTokens);
      }
      return responseJson({ authenticated: true, userId }, 200, headers);
    }
  } catch {
    // This foundation has no refresh adapter. Invalid, expired, or unreachable authority state is anonymous.
  }

  const headers = new Headers();
  appendOpenAuthSessionClearCookies(headers);
  return responseJson({ authenticated: false }, 200, headers);
};

/** Clears BFF cookies only after a strict same-origin unsafe-request check. */
export const logoutOpenAuth = async (
  env: OpenAuthBffEnvironment,
  request: Request,
): Promise<Response> => {
  const config = resolveConfig(env, request);
  if (!isConfig(config)) return config;
  if (!sameOriginLogoutRequest(request)) {
    return responseJson({ error: "invalid_logout_origin" }, 403);
  }

  const headers = new Headers({ "Cache-Control": "no-store" });
  appendOpenAuthSessionClearCookies(headers);
  return new Response(null, { status: 204, headers });
};

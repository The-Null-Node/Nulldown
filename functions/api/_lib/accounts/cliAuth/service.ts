import type { D1Database } from "@cloudflare/workers-types";

import {
  CLI_CREDENTIAL_KIND_V1,
  CLI_CREDENTIAL_ENVELOPE_KIND_V1,
  formatCliUserCode,
  isCliEncryptionPublicJwk,
  normalizeCliUserCode,
  type CliCredentialBundleV1,
  type CliCredentialEnvelopeV1,
  type CliEncryptionPublicJwk,
} from "../../../../../shared/auth/cliDevice";
import {
  issueAccountSessionToken,
  sanitizeAccountId,
} from "../session/auth";
import {
  isSameOriginOpenAuthRequest,
  resolveOpenAuthRequestIdentity,
  type OpenAuthBffEnvironment,
  type OpenAuthRequestIdentity,
} from "../openAuth/service";
import { readAccountBinding } from "../binding/repository";
import {
  approveCliDeviceTicket,
  insertCliDeviceTicket,
  readCliCredentialByRefreshHash,
  readCliDeviceTicketByDeviceHash,
  readCliDeviceTicketByUserHash,
  redeemCliDeviceTicket,
  revokeCliCredential,
  rotateCliCredential,
} from "./repository";

const DEFAULT_DEVICE_TICKET_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_ACCESS_TOKEN_TTL_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DEVICE_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const textEncoder = new TextEncoder();

/** Environment bindings used by the browser-mediated CLI authorization flow. */
export interface CliAuthEnvironment extends OpenAuthBffEnvironment {
  ACCOUNT_AUTH_SECRET?: string;
  ACCOUNT_AUTH_TOKEN_TTL_MS?: string;
  CLI_DEVICE_TICKET_TTL_MS?: string;
  CLI_CREDENTIAL_TTL_MS?: string;
  CLI_ACCESS_TOKEN_TTL_MS?: string;
  CLI_POLL_INTERVAL_SECONDS?: string;
}

const responseJson = (
  body: unknown,
  status: number,
  headers?: HeadersInit,
): Response => {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json");
  responseHeaders.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
};

const responseEmpty = (status: number, headers?: HeadersInit): Response => {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "no-store");
  return new Response(null, { status, headers: responseHeaders });
};

const parsePositiveNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const randomToken = (bytes = 32): string =>
  toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));

const hashToken = async (value: string): Promise<string> =>
  toBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(value))),
  );

const randomUserCode = (): string => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let value = "";
  for (const byte of bytes) value += alphabet[byte % alphabet.length];
  return value;
};

const parseObject = async (request: Request): Promise<Record<string, unknown> | null> => {
  try {
    const value = (await request.json()) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const parsePublicKey = (value: unknown): CliEncryptionPublicJwk | null =>
  isCliEncryptionPublicJwk(value) ? value : null;

const readStoredPublicKey = (json: string): CliEncryptionPublicJwk | null => {
  try {
    return parsePublicKey(JSON.parse(json));
  } catch {
    return null;
  }
};

const withIdentityHeaders = (
  identity: OpenAuthRequestIdentity,
  body: unknown,
  status: number,
): Response => responseJson(body, status, identity.responseHeaders);

const issueCliAccessToken = (env: CliAuthEnvironment, accountId: string) =>
  issueAccountSessionToken(accountId, {
    ...env,
    ACCOUNT_AUTH_TOKEN_TTL_MS: String(
      parsePositiveNumber(env.CLI_ACCESS_TOKEN_TTL_MS, DEFAULT_ACCESS_TOKEN_TTL_MS),
    ),
  });

const encryptCredentialBundle = async (
  publicJwk: CliEncryptionPublicJwk,
  bundle: CliCredentialBundleV1,
): Promise<CliCredentialEnvelopeV1> => {
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const contentKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = textEncoder.encode(JSON.stringify(bundle));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    contentKey,
    plaintext,
  );
  const rawContentKey = new Uint8Array(await crypto.subtle.exportKey("raw", contentKey));
  const wrappedKey = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    rawContentKey,
  );
  return {
    kind: CLI_CREDENTIAL_ENVELOPE_KIND_V1,
    wrappedKey: toBase64Url(new Uint8Array(wrappedKey)),
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
  };
};

const issueBundle = async (
  env: CliAuthEnvironment,
  request: Request,
  ticket: {
    ticket_id: string;
    device_code_hash: string;
    client_public_jwk_json: string;
    approved_user_id: string | null;
    approved_account_id: string | null;
  },
): Promise<CliCredentialEnvelopeV1 | Response> => {
  if (!env.DB || !env.ACCOUNT_AUTH_SECRET) {
    return responseJson({ error: "cli_auth_unavailable" }, 503);
  }
  const publicKey = readStoredPublicKey(ticket.client_public_jwk_json);
  if (!publicKey || !ticket.approved_user_id || !ticket.approved_account_id) {
    return responseJson({ error: "invalid_device_ticket" }, 409);
  }

  const createdAt = Date.now();
  const credentialExpiresAt =
    createdAt + parsePositiveNumber(env.CLI_CREDENTIAL_TTL_MS, DEFAULT_CREDENTIAL_TTL_MS);
  const refreshToken = randomToken();
  const credentialId = randomToken(16);
  const access = await issueCliAccessToken(env, ticket.approved_account_id);
  const bundle: CliCredentialBundleV1 = {
    kind: CLI_CREDENTIAL_KIND_V1,
    version: 1,
    baseUrl: new URL(request.url).origin,
    userId: ticket.approved_user_id,
    accountId: ticket.approved_account_id,
    credentialId,
    refreshToken,
    accessToken: access.token,
    accessExpiresAt: access.payload.exp,
    credentialExpiresAt,
    createdAt,
  };
  let envelope: CliCredentialEnvelopeV1;
  try {
    envelope = await encryptCredentialBundle(publicKey, bundle);
  } catch {
    return responseJson({ error: "credential_encryption_failed" }, 503);
  }
  const redeemed = await redeemCliDeviceTicket(env.DB, {
    ticketId: ticket.ticket_id,
    deviceCodeHash: ticket.device_code_hash,
    credentialId,
    refreshTokenHash: await hashToken(refreshToken),
    createdAt,
    expiresAt: credentialExpiresAt,
    redeemedAt: createdAt,
  });
  return redeemed ? envelope : responseJson({ error: "device_code_redeemed" }, 409);
};

/** Creates a short-lived device ticket and human approval code. */
export const createCliDeviceResponse = async (
  env: CliAuthEnvironment,
  request: Request,
): Promise<Response> => {
  if (!env.DB) return responseJson({ error: "cli_auth_unavailable" }, 503);
  const body = await parseObject(request);
  const publicKey = parsePublicKey(body?.publicKey);
  if (!publicKey) return responseJson({ error: "invalid_cli_public_key" }, 400);
  const clientName =
    typeof body?.clientName === "string" && body.clientName.trim()
      ? body.clientName.trim().slice(0, 80)
      : null;
  const createdAt = Date.now();
  const userCode = randomUserCode();
  const deviceCode = randomToken();
  const expiresAt =
    createdAt + parsePositiveNumber(env.CLI_DEVICE_TICKET_TTL_MS, DEFAULT_DEVICE_TICKET_TTL_MS);
  try {
    await insertCliDeviceTicket(env.DB, {
      ticketId: randomToken(16),
      deviceCodeHash: await hashToken(deviceCode),
      userCodeHash: await hashToken(userCode),
      publicKey,
      clientName,
      createdAt,
      expiresAt,
    });
  } catch {
    return responseJson({ error: "cli_auth_unavailable" }, 503);
  }

  const interval = Math.max(
    2,
    Math.floor(parsePositiveNumber(env.CLI_POLL_INTERVAL_SECONDS, DEFAULT_POLL_INTERVAL_SECONDS)),
  );
  return responseJson(
    {
      kind: "nulldown.cli-device.v1",
      deviceCode,
      userCode: formatCliUserCode(userCode),
      verificationUri: `${new URL(request.url).origin}/auth/cli`,
      expiresAt,
      interval,
    },
    201,
  );
};

/** Approves a device ticket after verifying the OpenAuth user owns the account. */
export const approveCliDeviceResponse = async (
  env: CliAuthEnvironment,
  request: Request,
): Promise<Response> => {
  const identity = await resolveOpenAuthRequestIdentity(env, request);
  if (identity instanceof Response) return identity;
  if (!isSameOriginOpenAuthRequest(request, identity.origin)) {
    return withIdentityHeaders(identity, { error: "invalid_origin" }, 403);
  }
  if (!env.DB) return withIdentityHeaders(identity, { error: "cli_auth_unavailable" }, 503);

  const body = await parseObject(request);
  const userCode = normalizeCliUserCode(body?.userCode);
  const accountId = sanitizeAccountId(body?.accountId);
  if (!userCode || !accountId) {
    return withIdentityHeaders(identity, { error: "invalid_cli_approval" }, 400);
  }

  try {
    const binding = await readAccountBinding(env.DB, accountId);
    if (!binding || binding.user_id !== identity.userId) {
      return withIdentityHeaders(identity, { error: "account_not_bound" }, 403);
    }
    const ticket = await readCliDeviceTicketByUserHash(env.DB, await hashToken(userCode));
    if (!ticket || ticket.expires_at <= Date.now()) {
      return withIdentityHeaders(identity, { error: "invalid_or_expired_cli_code" }, 409);
    }
    if (ticket.redeemed_at !== null) {
      return withIdentityHeaders(identity, { error: "cli_code_redeemed" }, 409);
    }
    if (ticket.approved_at !== null) {
      return ticket.approved_user_id === identity.userId &&
        ticket.approved_account_id === accountId
        ? withIdentityHeaders(identity, { approved: true, accountId }, 200)
        : withIdentityHeaders(identity, { error: "cli_code_already_approved" }, 409);
    }

    const approved = await approveCliDeviceTicket(env.DB, {
      ticketId: ticket.ticket_id,
      userId: identity.userId,
      accountId,
      approvedAt: Date.now(),
    });
    if (approved) return withIdentityHeaders(identity, { approved: true, accountId }, 200);

    const current = await readCliDeviceTicketByUserHash(env.DB, await hashToken(userCode));
    return current?.approved_user_id === identity.userId &&
      current.approved_account_id === accountId
      ? withIdentityHeaders(identity, { approved: true, accountId }, 200)
      : withIdentityHeaders(identity, { error: "cli_code_already_approved" }, 409);
  } catch {
    return withIdentityHeaders(identity, { error: "cli_auth_unavailable" }, 503);
  }
};

/** Polls a device ticket and returns an encrypted credential after approval. */
export const pollCliDeviceResponse = async (
  env: CliAuthEnvironment,
  request: Request,
): Promise<Response> => {
  if (!env.DB) return responseJson({ error: "cli_auth_unavailable" }, 503);
  const body = await parseObject(request);
  const deviceCode = body?.deviceCode;
  if (typeof deviceCode !== "string" || !DEVICE_CODE_PATTERN.test(deviceCode)) {
    return responseJson({ error: "invalid_device_code" }, 400);
  }

  try {
    const ticket = await readCliDeviceTicketByDeviceHash(env.DB, await hashToken(deviceCode));
    if (!ticket) return responseJson({ error: "invalid_device_code" }, 400);
    if (ticket.expires_at <= Date.now()) return responseJson({ status: "expired" }, 200);
    if (ticket.redeemed_at !== null) {
      return responseJson({ error: "device_code_redeemed" }, 409);
    }
    if (ticket.approved_at === null) {
      return responseJson(
        {
          status: "pending",
          interval: Math.max(
            2,
            Math.floor(
              parsePositiveNumber(env.CLI_POLL_INTERVAL_SECONDS, DEFAULT_POLL_INTERVAL_SECONDS),
            ),
          ),
        },
        200,
      );
    }

    const envelope = await issueBundle(env, request, ticket);
    if (envelope instanceof Response) return envelope;
    return responseJson({ status: "approved", envelope }, 200);
  } catch {
    return responseJson({ error: "cli_auth_unavailable" }, 503);
  }
};

/** Rotates a refresh credential and issues a fresh short-lived account bearer. */
export const refreshCliCredentialResponse = async (
  env: CliAuthEnvironment,
  request: Request,
): Promise<Response> => {
  if (!env.DB || !env.ACCOUNT_AUTH_SECRET) {
    return responseJson({ error: "cli_auth_unavailable" }, 503);
  }
  const body = await parseObject(request);
  const refreshToken = body?.refreshToken;
  if (typeof refreshToken !== "string" || refreshToken.length < 32) {
    return responseJson({ error: "invalid_refresh_token" }, 400);
  }

  try {
    const previousHash = await hashToken(refreshToken);
    const credential = await readCliCredentialByRefreshHash(env.DB, previousHash);
    if (!credential || credential.revoked_at !== null || credential.expires_at <= Date.now()) {
      return responseJson({ error: "invalid_refresh_token" }, 401);
    }
    const nextRefreshToken = randomToken();
    const now = Date.now();
    const rotated = await rotateCliCredential(env.DB, {
      credentialId: credential.credential_id,
      previousRefreshTokenHash: previousHash,
      nextRefreshTokenHash: await hashToken(nextRefreshToken),
      lastUsedAt: now,
    });
    if (!rotated) return responseJson({ error: "invalid_refresh_token" }, 401);
    const access = await issueCliAccessToken(env, credential.account_id);
    return responseJson(
      {
        kind: CLI_CREDENTIAL_KIND_V1,
        version: 1,
        credentialId: credential.credential_id,
        userId: credential.user_id,
        accountId: credential.account_id,
        refreshToken: nextRefreshToken,
        accessToken: access.token,
        accessExpiresAt: access.payload.exp,
        credentialExpiresAt: credential.expires_at,
        createdAt: credential.created_at,
        baseUrl: new URL(request.url).origin,
      },
      200,
    );
  } catch {
    return responseJson({ error: "cli_auth_unavailable" }, 503);
  }
};

/** Revokes a refresh credential without exposing whether it previously existed. */
export const revokeCliCredentialResponse = async (
  env: CliAuthEnvironment,
  request: Request,
): Promise<Response> => {
  if (!env.DB) return responseJson({ error: "cli_auth_unavailable" }, 503);
  const body = await parseObject(request);
  const refreshToken = body?.refreshToken;
  if (typeof refreshToken !== "string" || refreshToken.length < 32) {
    return responseJson({ error: "invalid_refresh_token" }, 400);
  }
  try {
    await revokeCliCredential(env.DB, await hashToken(refreshToken), Date.now());
  } catch {
    return responseJson({ error: "cli_auth_unavailable" }, 503);
  }
  return responseEmpty(204);
};

import type { DropEnvelopeV1, DropVisibility } from "../../../../../shared/drop/types";
import type { VoidBlobStore, VoidSqlStore } from "../../../../../src/server/ports";
import {
  readAccountRecord,
  resolveAuthenticatedAccountId,
  verifyAccountSessionToken,
  type AccountAuthRequest,
  type AccountAuthEnv,
} from "../session/auth";
import {
  sameDeviceSigningKey,
  sameEncryptionRecipientKey,
  verifyDropDeviceDelegationSignature,
  verifyDropEnvelopeDeviceSignature,
} from "../../crypto/envelopes/verification";
import {
  listAccountLibraryEntries,
  upsertAccountLibraryEntry,
  type AccountLibraryCursor,
} from "./repository";
import { listAccountBindingsForUser } from "../binding/repository";
import {
  resolveOpenAuthRequestIdentity,
  type OpenAuthBffEnvironment,
} from "../openAuth/service";

export interface AccountLibraryEnv extends Omit<AccountAuthEnv, "R2_BUCKET"> {
  DB?: VoidSqlStore;
}

interface AccountLibraryProjectionEnv extends AccountLibraryEnv {
  R2_BUCKET?: VoidBlobStore;
}

export class AccountLibraryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type AccountLibraryVerificationReason =
  | "account_mismatch"
  | "credential_claim_required"
  | "credential_inactive"
  | "delegation_expired"
  | "untrusted_device_signature";

export type AccountLibraryVerification =
  | { accountId: string; reason: null }
  | { accountId: null; reason: AccountLibraryVerificationReason };

const encodeCursor = (cursor: AccountLibraryCursor): string =>
  btoa(JSON.stringify(cursor)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

const decodeCursor = (value: string | null): AccountLibraryCursor | null => {
  if (!value) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const parsed = JSON.parse(atob(padded)) as Record<string, unknown>;
    if (
      typeof parsed.watermark !== "number" ||
      typeof parsed.beforeSeq !== "number" ||
      !Number.isSafeInteger(parsed.watermark) ||
      !Number.isSafeInteger(parsed.beforeSeq) ||
      parsed.watermark < 0 ||
      parsed.beforeSeq < 0
    ) {
      return null;
    }
    return { watermark: parsed.watermark, beforeSeq: parsed.beforeSeq };
  } catch {
    return null;
  }
};

const parseLimit = (value: string | null): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 50;
};

const hasBearer = (request: AccountAuthRequest): boolean =>
  request.headers.get("Authorization")?.startsWith("Bearer ") ?? false;

const resolveAuthenticatedAccountClaims = async (
  request: AccountAuthRequest,
  env: AccountAuthEnv,
): Promise<{ accountId: string | null; credentialId: string | null }> => {
  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) {
    return { accountId: await resolveAuthenticatedAccountId(request, env), credentialId: null };
  }
  const token = authorization.slice("Bearer ".length).trim();
  const payload = token ? await verifyAccountSessionToken(token, env) : null;
  return {
    accountId: payload?.accountId ?? null,
    credentialId: payload?.credentialId ?? null,
  };
};

const isVisibility = (value: string | undefined): value is DropVisibility =>
  value === "private" || value === "unlisted" || value === "public";

/** Validates direct or delegated envelope ownership before its metadata is projected. */
export const verifyAccountLibraryEnvelopeOwnership = async (
  env: AccountLibraryProjectionEnv,
  envelope: DropEnvelopeV1,
  authenticatedAccountId: string | null,
  authenticatedCredentialId: string | null,
): Promise<AccountLibraryVerification> => {
  if (!env.R2_BUCKET || !env.DB) {
    throw new AccountLibraryError(500, "account_library_unavailable", "Account-library storage bindings are required.");
  }
  if (authenticatedAccountId && envelope.accountId !== authenticatedAccountId) {
    return { accountId: null, reason: "account_mismatch" };
  }
  const record = await readAccountRecord(env.R2_BUCKET, envelope.accountId, env.DB);
  if (!record || !envelope.deviceSignerPublicJwk) {
    return { accountId: null, reason: "untrusted_device_signature" };
  }
  if (!(await verifyDropEnvelopeDeviceSignature(envelope))) {
    return { accountId: null, reason: "untrusted_device_signature" };
  }
  if (!envelope.deviceDelegation) {
    return sameDeviceSigningKey(record.signingPublicJwk, envelope.deviceSignerPublicJwk)
      ? { accountId: envelope.accountId, reason: null }
      : { accountId: null, reason: "untrusted_device_signature" };
  }

  const delegation = envelope.deviceDelegation;
  if (
    delegation.accountId !== envelope.accountId ||
    delegation.expiresAt <= Date.now() ||
    !record.encryptionKid ||
    !record.encryptionPublicJwk ||
    delegation.encryptionKid !== envelope.keyEnvelope.kid ||
    delegation.encryptionKid !== record.encryptionKid ||
    !sameEncryptionRecipientKey(
      delegation.encryptionPublicJwk,
      record.encryptionPublicJwk,
    ) ||
    !sameDeviceSigningKey(delegation.delegateSigningPublicJwk, envelope.deviceSignerPublicJwk) ||
    !(await verifyDropDeviceDelegationSignature(delegation, record.signingPublicJwk))
  ) {
    return {
      accountId: null,
      reason: delegation.expiresAt <= Date.now() ? "delegation_expired" : "untrusted_device_signature",
    };
  }
  const credential = await env.DB
    .prepare(
      `SELECT credential_id, account_id, expires_at, revoked_at
       FROM auth_cli_credentials WHERE credential_id = ?`,
    )
    .bind(delegation.credentialId)
    .first<{
      credential_id: string;
      account_id: string;
      expires_at: number;
      revoked_at: number | null;
    }>();
  if (
    !credential ||
    credential.account_id !== envelope.accountId ||
    credential.revoked_at !== null ||
    credential.expires_at <= Date.now()
  ) {
    return { accountId: null, reason: "credential_inactive" };
  }
  if (authenticatedAccountId && authenticatedCredentialId !== delegation.credentialId) {
    return { accountId: null, reason: "credential_claim_required" };
  }
  return { accountId: envelope.accountId, reason: null };
};

/** Validates an authenticated write envelope before ownership projection. */
export const verifyAccountLibraryEnvelope = async (
  request: AccountAuthRequest,
  env: AccountLibraryProjectionEnv,
  envelope: DropEnvelopeV1,
): Promise<string | null> => {
  const authenticated = await resolveAuthenticatedAccountClaims(request, env);
  const requiresAccount = hasBearer(request) || envelope.visibility === "private";
  if (!requiresAccount) return null;
  if (!authenticated.accountId) {
    throw new AccountLibraryError(401, "account_auth_required", "An authenticated account session is required.");
  }
  const verified = await verifyAccountLibraryEnvelopeOwnership(
    env,
    envelope,
    authenticated.accountId,
    authenticated.credentialId,
  );
  if (!verified.accountId) {
    const code = verified.reason ?? "untrusted_device_signature";
    throw new AccountLibraryError(
      403,
      code,
      code === "credential_claim_required"
        ? "The delegated CLI credential is not bound to this bearer."
        : "The envelope signer is not trusted for this account.",
    );
  }
  return verified.accountId;
};

/** Persists the verified, metadata-only ownership projection for an authenticated envelope. */
export const projectAccountLibraryEnvelope = async (
  db: VoidSqlStore,
  dropId: string,
  accountId: string | null,
  envelope: DropEnvelopeV1 | null,
  updatedAt: number,
): Promise<void> => {
  if (!accountId || !envelope) return;
  const visibility = isVisibility(envelope.visibility) ? envelope.visibility : "unlisted";
  await upsertAccountLibraryEntry(db, {
    dropId,
    accountId,
    visibility,
    createdAt: envelope.createdAt,
    updatedAt,
  });
};

/** Lists metadata-only remote entries owned by the authenticated account. */
export const listAuthenticatedAccountLibrary = async (
  request: Request,
  env: OpenAuthBffEnvironment,
) => {
  const identity = await resolveOpenAuthRequestIdentity(env, request);
  if (identity instanceof Response) {
    throw new AccountLibraryError(
      identity.status,
      identity.status === 401 ? "open_auth_required" : "account_library_unavailable",
      identity.status === 401
        ? "An authenticated user session is required."
        : "Account-library authority is unavailable.",
    );
  }
  const url = new URL(request.url);
  const cursorValue = url.searchParams.get("cursor");
  const cursor = decodeCursor(cursorValue);
  if (cursorValue && !cursor) {
    throw new AccountLibraryError(400, "invalid_cursor", "The account-library cursor is invalid.");
  }
  const bindings = await listAccountBindingsForUser(identity.db, identity.userId);
  const page = await listAccountLibraryEntries(
    identity.db,
    bindings.map((binding) => binding.account_id),
    parseLimit(url.searchParams.get("limit")),
    cursor,
  );
  return {
    page: { items: page.items, cursor: page.cursor ? encodeCursor(page.cursor) : null },
    responseHeaders: identity.responseHeaders,
  };
};

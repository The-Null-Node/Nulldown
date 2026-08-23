import {
  parseAccountBindingChallenge,
  serializeAccountBindingChallenge,
} from "../../../shared/auth/accountBinding";
import {
  parseEncryptedAccountRecoveryPackage,
  serializeAccountRecoveryPackage,
  type EncryptedAccountRecoveryPackageV1,
} from "../../../shared/auth/recovery";
import {
  activateAccountSession,
  authenticateAccountSigningKey,
  clearAccountSession,
  getAccountAuthHeaders,
} from "./accountSession";
import {
  getOpenAuthSessionState,
  OPEN_AUTH_LOGOUT_STORAGE_KEY,
  type OpenAuthPrincipal,
} from "./openAuthClient";
import {
  exportLocalAccountRecoveryPayload,
  assignLocalAccountOwner,
  getLocalAccountSummary,
  getUnlockedVault,
  installLocalAccountRecoveryPayload,
} from "../void/vault/passkeyVault";
import {
  decryptAccountRecoveryPackage,
  encryptAccountRecoveryPayload,
} from "../void/vault/recovery/crypto";
import { getKvValue, isIndexedDbSupported } from "../indexedDb";

const CHALLENGE_PATH = "/api/account/challenge";
const BIND_PATH = "/api/account/bind";
const RECOVERY_PATH = "/api/account/recovery";
const PENDING_RECOVERY_KEY = "nulldown_pending_recovery_v1";
let syncGeneration = 0;

export type AccountSyncState =
  | { status: "setup"; accountId: string }
  | {
      status: "restore";
      accountId: string;
      localAccountId: string | null;
      package: EncryptedAccountRecoveryPackageV1;
    }
  | { status: "unconfirmed"; accountId: string; revision: number }
  | { status: "ready"; accountId: string; revision: number }
  | { status: "empty" };

interface PendingRecovery {
  accountId: string;
  revision: number;
  ciphertextDigest: string;
}

export class AccountSyncUploadUncertainError extends Error {
  constructor(
    readonly recoveryCode: string,
    readonly accountId: string,
    readonly revision: number,
    readonly ciphertextDigest: string,
  ) {
    super("The encrypted package may be stored. Save this code before retrying.");
    this.name = "AccountSyncUploadUncertainError";
  }
}

export class RecoveryPackageMismatchError extends Error {
  constructor() {
    super("This recovery code belongs to a package that lost a competing update.");
    this.name = "RecoveryPackageMismatchError";
  }
}

/** Invalidates setup or restore work when the signed-in browser identity changes. */
export const cancelAccountSyncOperations = (): void => {
  syncGeneration += 1;
};

const readPendingRecovery = (): PendingRecovery | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PENDING_RECOVERY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingRecovery>;
    return typeof parsed.accountId === "string" &&
      Number.isSafeInteger(parsed.revision) &&
      (parsed.revision ?? 0) > 0 &&
      typeof parsed.ciphertextDigest === "string"
      ? {
          accountId: parsed.accountId,
          revision: parsed.revision as number,
          ciphertextDigest: parsed.ciphertextDigest,
        }
      : null;
  } catch {
    return null;
  }
};

const writePendingRecovery = (pending: PendingRecovery): void => {
  if (typeof window === "undefined") {
    throw new Error("Browser storage is unavailable for account sync.");
  }
  window.localStorage.setItem(PENDING_RECOVERY_KEY, JSON.stringify(pending));
};

/** Verifies that the encrypted recovery package is still durable and unchanged. */
const assertAccountSyncRecoveryPackage = async (
  accountId: string,
  revision: number,
  ciphertextDigest: string,
): Promise<void> => {
  const encryptedPackage = await readRecovery();
  if (
    !encryptedPackage ||
    encryptedPackage.metadata.accountId !== accountId ||
    encryptedPackage.metadata.revision !== revision
  ) {
    throw new Error("Encrypted account data is not yet durable. Retry sync before continuing.");
  }
  if (encryptedPackage.metadata.ciphertextDigest !== ciphertextDigest) {
    throw new RecoveryPackageMismatchError();
  }
};

/** Records that the user has acknowledged the only copy of a generated recovery code. */
export const confirmAccountSyncRecoveryCode = async (
  accountId: string,
  revision: number,
  ciphertextDigest: string,
): Promise<void> => {
  const pending = readPendingRecovery();
  await assertAccountSyncRecoveryPackage(accountId, revision, ciphertextDigest);
  if (pending?.accountId === accountId && pending.revision === revision) {
    window.localStorage.removeItem(PENDING_RECOVERY_KEY);
  }
};

const readLogoutVersion = (): string | null => {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(OPEN_AUTH_LOGOUT_STORAGE_KEY);
  } catch {
    return null;
  }
};

const assertCurrentPrincipal = async (
  principal: OpenAuthPrincipal,
  generation: number,
): Promise<void> => {
  const session = await getOpenAuthSessionState();
  if (
    generation !== syncGeneration ||
    session.status !== "authenticated" ||
    session.principal.userId !== principal.userId
  ) {
    throw new Error("Signed-in user changed during account sync.");
  }
};

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const accountHeaders = async (): Promise<Record<string, string>> => {
  const headers = await getAccountAuthHeaders();
  if (!headers.Authorization) throw new Error("Current account could not be authenticated.");
  return headers;
};

const readRecovery = async (): Promise<EncryptedAccountRecoveryPackageV1 | null> => {
  const response = await fetch(RECOVERY_PATH, {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Account sync is unavailable.");
  const body = (await response.json()) as { package?: unknown };
  const encryptedPackage = parseEncryptedAccountRecoveryPackage(body.package);
  if (!encryptedPackage) throw new Error("Synced account data is invalid.");
  return encryptedPackage;
};

/** Determines the smallest user action without creating a replacement local account. */
export const getAccountSyncState = async (
  principal: OpenAuthPrincipal,
): Promise<AccountSyncState> => {
  const [localAccount, encryptedPackage] = await Promise.all([
    getLocalAccountSummary(),
    readRecovery(),
  ]);
  const localAccountId =
    !localAccount?.ownerUserId || localAccount.ownerUserId === principal.userId
      ? localAccount?.accountId ?? null
      : null;
  if (!encryptedPackage) {
    return localAccountId ? { status: "setup", accountId: localAccountId } : { status: "empty" };
  }
  if (encryptedPackage.metadata.userId !== principal.userId) {
    throw new Error("Synced account belongs to a different user.");
  }
  if (localAccountId === encryptedPackage.metadata.accountId) {
    if (!localAccount?.ownerUserId) {
      await assignLocalAccountOwner(principal.userId, localAccountId);
    }
    const pending = readPendingRecovery();
    return pending?.accountId === localAccountId &&
      pending.revision === encryptedPackage.metadata.revision
      ? {
          status: "unconfirmed",
          accountId: localAccountId,
          revision: encryptedPackage.metadata.revision,
        }
      : {
          status: "ready",
          accountId: localAccountId,
          revision: encryptedPackage.metadata.revision,
        };
  }
  return {
    status: "restore",
    accountId: encryptedPackage.metadata.accountId,
    localAccountId: localAccount?.accountId ?? null,
    package: encryptedPackage,
  };
};

const bindCurrentAccount = async (): Promise<string> => {
  const headers = await accountHeaders();
  const challengeResponse = await fetch(CHALLENGE_PATH, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers,
  });
  if (!challengeResponse.ok) throw new Error("Current account could not be connected.");
  const challengeBody = (await challengeResponse.json()) as {
    bound?: unknown;
    accountId?: unknown;
    challenge?: unknown;
  };
  if (challengeBody.bound === true && typeof challengeBody.accountId === "string") {
    return challengeBody.accountId;
  }
  const challenge = parseAccountBindingChallenge(challengeBody.challenge);
  if (!challenge) throw new Error("Account connection challenge is invalid.");
  const vault = await getUnlockedVault();
  if (vault.accountId !== challenge.accountId) {
    throw new Error("Current account changed during sync setup.");
  }
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    vault.signingPrivateKey,
    new TextEncoder().encode(serializeAccountBindingChallenge(challenge)),
  );
  const bindResponse = await fetch(BIND_PATH, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      challenge,
      signature: toBase64Url(new Uint8Array(signature)),
    }),
  });
  if (!bindResponse.ok) throw new Error("Current account could not be connected.");
  return challenge.accountId;
};

/** Binds, encrypts, and uploads the current V1 account, returning its one-time recovery code. */
export const setupAccountSync = async (
  principal: OpenAuthPrincipal,
  revision = 1,
): Promise<{
  recoveryCode: string;
  accountId: string;
  revision: number;
  ciphertextDigest: string;
}> => {
  const generation = syncGeneration;
  const accountId = await bindCurrentAccount();
  const payload = await exportLocalAccountRecoveryPayload();
  if (payload.accountId !== accountId) throw new Error("Current account changed during sync setup.");
  await assertCurrentPrincipal(principal, generation);
  await assignLocalAccountOwner(principal.userId, accountId);
  try {
    const encrypted = await encryptAccountRecoveryPayload({
      payload,
      userId: principal.userId,
      revision,
    });
    const vault = await getUnlockedVault();
    if (vault.accountId !== accountId) {
      throw new Error("Current account changed during sync setup.");
    }
    const signature = toBase64Url(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          vault.signingPrivateKey,
          new TextEncoder().encode(serializeAccountRecoveryPackage(encrypted.package)),
        ),
      ),
    );
    const headers = await accountHeaders();
    writePendingRecovery({
      accountId,
      revision,
      ciphertextDigest: encrypted.package.metadata.ciphertextDigest,
    });
    let response: Response;
    try {
      response = await fetch(RECOVERY_PATH, {
        method: "PUT",
        credentials: "same-origin",
        cache: "no-store",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ package: encrypted.package, signature }),
      });
    } catch {
      throw new AccountSyncUploadUncertainError(
        encrypted.recoveryCode,
        accountId,
        revision,
        encrypted.package.metadata.ciphertextDigest,
      );
    }
    if (!response.ok) {
      throw new Error("Encrypted account data could not be stored.");
    }
    await assertCurrentPrincipal(principal, generation);
    return {
      recoveryCode: encrypted.recoveryCode,
      accountId,
      revision,
      ciphertextDigest: encrypted.package.metadata.ciphertextDigest,
    };
  } catch (error) {
    throw error;
  }
};

/** Restores the exact V1 account and verifies it can obtain a fresh account session. */
export const restoreAccountSync = async (
  principal: OpenAuthPrincipal,
  recoveryCode: string,
  options: { allowReplaceLocalAccount?: boolean } = {},
): Promise<{ accountId: string; preservedAccountId: string | null }> => {
  const generation = syncGeneration;
  const logoutVersion = readLogoutVersion();
  const indexedDbLogoutVersion = isIndexedDbSupported()
    ? await getKvValue<string>(OPEN_AUTH_LOGOUT_STORAGE_KEY)
    : null;
  const encryptedPackage = await readRecovery();
  if (!encryptedPackage || encryptedPackage.metadata.userId !== principal.userId) {
    throw new Error("No synced account is available for this user.");
  }
  const payload = await decryptAccountRecoveryPackage(encryptedPackage, recoveryCode.trim());
  const signingPrivateKey = await crypto.subtle.importKey(
    "jwk",
    payload.signingPrivateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const verifiedSession = await authenticateAccountSigningKey({
    accountId: payload.accountId,
    signingPrivateKey,
    signingPublicJwk: payload.signingPublicJwk,
  });
  if (!verifiedSession) {
    throw new Error("Recovered account could not be authenticated.");
  }
  await assertCurrentPrincipal(principal, generation);
  const localAccount = await getLocalAccountSummary();
  if (
    localAccount &&
    localAccount.accountId !== payload.accountId &&
    !options.allowReplaceLocalAccount
  ) {
    throw new Error("Confirm replacement of the current local account.");
  }
  await assertAccountSyncRecoveryPackage(
    payload.accountId,
    encryptedPackage.metadata.revision,
    encryptedPackage.metadata.ciphertextDigest,
  );
  const installed = await installLocalAccountRecoveryPayload(
    payload,
    principal.userId,
    () =>
      generation === syncGeneration && readLogoutVersion() === logoutVersion,
    isIndexedDbSupported()
      ? {
          key: OPEN_AUTH_LOGOUT_STORAGE_KEY,
          expectedValue: indexedDbLogoutVersion,
        }
      : undefined,
  );
  if (generation !== syncGeneration || readLogoutVersion() !== logoutVersion) {
    return installed;
  }
  clearAccountSession();
  activateAccountSession({ ...verifiedSession, ownerUserId: principal.userId });
  return installed;
};

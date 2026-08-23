import {
  getActiveVaultUser,
  getLocalAccountSummary,
  getUnlockedVault,
} from "../void/vault/passkeyVault";

export interface AccountSessionCredentials {
  token: string;
  expiresAt: number;
  accountId: string;
  ownerUserId?: string | null;
}

type CachedAccountSession = AccountSessionCredentials;

const ACCOUNT_SESSION_STORAGE_KEY = "nulldown_account_session_v1";
let memorySession: CachedAccountSession | null = null;
let nextSessionFetchAllowedAt = 0;
let inFlightSessionTokenPromise: Promise<string | null> | null = null;
let sessionGeneration = 0;

/** Clears the V1 bearer cache after account replacement or explicit user sign-out. */
export const clearAccountSession = (): void => {
  sessionGeneration += 1;
  memorySession = null;
  nextSessionFetchAllowedAt = 0;
  inFlightSessionTokenPromise = null;
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(ACCOUNT_SESSION_STORAGE_KEY);
  } catch {
    // A stale entry is still account-checked by the server and expires normally.
  }
};

/** Activates a session proven before an atomic local account replacement. */
export const activateAccountSession = (session: AccountSessionCredentials): void => {
  writeStoredSession(session);
};

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

const readStoredSession = (): CachedAccountSession | null => {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.sessionStorage.getItem(ACCOUNT_SESSION_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<CachedAccountSession>;
    if (
      typeof parsed.token !== "string" ||
      typeof parsed.expiresAt !== "number" ||
      typeof parsed.accountId !== "string"
    ) {
      return null;
    }

    return {
      token: parsed.token,
      expiresAt: parsed.expiresAt,
      accountId: parsed.accountId,
      ownerUserId:
        typeof parsed.ownerUserId === "string" ? parsed.ownerUserId : null,
    };
  } catch {
    return null;
  }
};

const writeStoredSession = (session: CachedAccountSession): void => {
  memorySession = session;
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(
      ACCOUNT_SESSION_STORAGE_KEY,
      JSON.stringify(session),
    );
  } catch {
    // ignore storage failures
  }
};

const isSessionFresh = (session: CachedAccountSession | null): boolean => {
  if (!session) return false;
  return session.expiresAt - Date.now() > 30_000;
};

/** Requests a V1 bearer for explicit key material without changing the local vault. */
export const authenticateAccountSigningKey = async (input: Readonly<{
  accountId: string;
  signingPrivateKey: CryptoKey;
  signingPublicJwk: JsonWebKey;
  ownerUserId?: string | null;
}>): Promise<AccountSessionCredentials | null> => {
  const signedAt = Date.now();
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    input.signingPrivateKey,
    new TextEncoder().encode(
      `nulldown-account-auth\n${input.accountId}\n${signedAt}`,
    ),
  );
  const response = await fetch("/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      accountId: input.accountId,
      signingPublicJwk: input.signingPublicJwk,
      signedAt,
      signature: toBase64Url(new Uint8Array(signature)),
    }),
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as Partial<AccountSessionCredentials>;
  if (
    typeof payload.token !== "string" ||
    typeof payload.expiresAt !== "number" ||
    payload.accountId !== input.accountId
  ) {
    return null;
  }
  return {
    token: payload.token,
    expiresAt: payload.expiresAt,
    accountId: payload.accountId,
    ...(input.ownerUserId ? { ownerUserId: input.ownerUserId } : {}),
  };
};

const sessionMatchesLocalAccount = (
  session: CachedAccountSession | null,
  localAccount: { accountId: string; ownerUserId: string | null } | null,
): boolean => {
  if (!session || !localAccount || session.accountId !== localAccount.accountId) {
    return false;
  }
  if (!localAccount.ownerUserId) return !session.ownerUserId;
  return (
    session.ownerUserId === localAccount.ownerUserId &&
    getActiveVaultUser() === localAccount.ownerUserId
  );
};

export const getAccountSessionToken = async (
  options: { forceRefresh?: boolean } = {},
): Promise<string | null> => {
  if (!options.forceRefresh && Date.now() < nextSessionFetchAllowedAt) {
    return null;
  }

  const localAccount = await getLocalAccountSummary();
  if (
    localAccount?.ownerUserId &&
    getActiveVaultUser() !== localAccount.ownerUserId
  ) {
    clearAccountSession();
    return null;
  }

  if (!options.forceRefresh) {
    if (isSessionFresh(memorySession) && sessionMatchesLocalAccount(memorySession, localAccount)) {
      return memorySession?.token ?? null;
    }

    const stored = readStoredSession();
    if (isSessionFresh(stored) && sessionMatchesLocalAccount(stored, localAccount)) {
      memorySession = stored;
      return stored?.token ?? null;
    }

    if (inFlightSessionTokenPromise) {
      return inFlightSessionTokenPromise;
    }
  }

  const requestToken = async (): Promise<string | null> => {
    const requestGeneration = sessionGeneration;
    let vault;
    try {
      vault = await getUnlockedVault();
    } catch {
      return null;
    }

    const session = await authenticateAccountSigningKey({
      accountId: vault.accountId,
      signingPrivateKey: vault.signingPrivateKey,
      signingPublicJwk: vault.signingPublicJwk,
      ownerUserId: localAccount?.ownerUserId,
    });
    if (!session) {
      nextSessionFetchAllowedAt = Date.now() + 60_000;
      return null;
    }
    if (requestGeneration !== sessionGeneration) return null;
    nextSessionFetchAllowedAt = 0;
    writeStoredSession(session);
    return session.token;
  };

  const promise = requestToken().finally(() => {
    if (inFlightSessionTokenPromise === promise) {
      inFlightSessionTokenPromise = null;
    }
  });

  inFlightSessionTokenPromise = promise;
  return promise;
};

export const getAccountAuthHeaders = async (): Promise<
  Record<string, string>
> => {
  const token = await getAccountSessionToken();
  if (!token) {
    return {};
  }

  return {
    Authorization: `Bearer ${token}`,
  };
};

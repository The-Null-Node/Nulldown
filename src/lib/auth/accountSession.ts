import { getUnlockedVault } from "../void/vault/passkeyVault";

interface AccountSessionResponse {
  token: string;
  expiresAt: number;
  accountId: string;
}

interface CachedAccountSession {
  token: string;
  expiresAt: number;
  accountId: string;
}

const ACCOUNT_SESSION_STORAGE_KEY = "nulldown_account_session_v1";
const textEncoder = new TextEncoder();

let memorySession: CachedAccountSession | null = null;
let nextSessionFetchAllowedAt = 0;
let inFlightSessionTokenPromise: Promise<string | null> | null = null;

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

export const getAccountSessionToken = async (
  options: { forceRefresh?: boolean } = {},
): Promise<string | null> => {
  if (!options.forceRefresh && Date.now() < nextSessionFetchAllowedAt) {
    return null;
  }

  if (!options.forceRefresh) {
    if (isSessionFresh(memorySession)) {
      return memorySession?.token ?? null;
    }

    const stored = readStoredSession();
    if (isSessionFresh(stored)) {
      memorySession = stored;
      return stored?.token ?? null;
    }

    if (inFlightSessionTokenPromise) {
      return inFlightSessionTokenPromise;
    }
  }

  const requestToken = async (): Promise<string | null> => {
    let vault;
    try {
      vault = await getUnlockedVault();
    } catch {
      return null;
    }

    const signedAt = Date.now();
    const message = `nulldown-account-auth\n${vault.accountId}\n${signedAt}`;
    const signature = await crypto.subtle.sign(
      {
        name: "ECDSA",
        hash: "SHA-256",
      },
      vault.signingPrivateKey,
      textEncoder.encode(message),
    );

    const response = await fetch("/api/auth/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accountId: vault.accountId,
        signingPublicJwk: vault.signingPublicJwk,
        signedAt,
        signature: toBase64Url(new Uint8Array(signature)),
      }),
    });

    if (!response.ok) {
      nextSessionFetchAllowedAt =
        Date.now() + (response.status === 503 ? 5 * 60_000 : 60_000);
      return null;
    }

    nextSessionFetchAllowedAt = 0;

    const payload = (await response.json()) as AccountSessionResponse;
    if (
      typeof payload.token !== "string" ||
      typeof payload.expiresAt !== "number" ||
      typeof payload.accountId !== "string"
    ) {
      return null;
    }

    writeStoredSession({
      token: payload.token,
      expiresAt: payload.expiresAt,
      accountId: payload.accountId,
    });

    return payload.token;
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

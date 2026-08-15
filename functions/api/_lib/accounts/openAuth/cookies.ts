const ACCESS_COOKIE = "__Host-nulldown-open-auth-access";
const REFRESH_COOKIE = "__Host-nulldown-open-auth-refresh";
const TRANSACTION_COOKIE = "__Host-nulldown-open-auth-transaction";
const COOKIE_ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Lax";

/** Raw, short-lived authorization flow values kept only in an HttpOnly BFF cookie. */
export interface OpenAuthTransactionCookie {
  state: string;
  nonce: string;
  verifier: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const toBase64Url = (input: Uint8Array): string => {
  let binary = "";
  input.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const fromBase64Url = (value: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;

  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
};

const readCookie = (request: Request, name: string): string | null => {
  const cookies = request.headers.get("cookie");
  if (!cookies) return null;

  for (const segment of cookies.split(";")) {
    const [key, ...value] = segment.trim().split("=");
    if (key === name) return value.join("=") || null;
  }
  return null;
};

const encodeCookie = (value: unknown): string =>
  toBase64Url(textEncoder.encode(JSON.stringify(value)));

const decodeTransaction = (value: string | null): OpenAuthTransactionCookie | null => {
  if (!value) return null;
  const bytes = fromBase64Url(value);
  if (!bytes) return null;

  try {
    const parsed = JSON.parse(textDecoder.decode(bytes)) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).length !== 3 ||
      typeof record.state !== "string" ||
      typeof record.nonce !== "string" ||
      typeof record.verifier !== "string"
    ) {
      return null;
    }
    return { state: record.state, nonce: record.nonce, verifier: record.verifier };
  } catch {
    return null;
  }
};

const setCookie = (name: string, value: string, maxAge: number): string =>
  `${name}=${value}; Max-Age=${maxAge}; ${COOKIE_ATTRIBUTES}`;

const clearCookie = (name: string): string =>
  `${name}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${COOKIE_ATTRIBUTES}`;

/** Reads the BFF-only access credential without exposing it to route responses. */
export const readOpenAuthAccessCookie = (request: Request): string | null =>
  readCookie(request, ACCESS_COOKIE);

/** Reads the BFF-only transaction cookie. */
export const readOpenAuthTransactionCookie = (
  request: Request,
): OpenAuthTransactionCookie | null =>
  decodeTransaction(readCookie(request, TRANSACTION_COOKIE));

/** Appends the short-lived authorization transaction cookie to a response. */
export const appendOpenAuthTransactionCookie = (
  headers: Headers,
  transaction: OpenAuthTransactionCookie,
  maxAgeSeconds: number,
): void => {
  headers.append(
    "Set-Cookie",
    setCookie(TRANSACTION_COOKIE, encodeCookie(transaction), maxAgeSeconds),
  );
};

/** Appends BFF-only access and refresh cookies. */
export const appendOpenAuthSessionCookies = (
  headers: Headers,
  tokens: Readonly<{ access: string; refresh: string; expiresIn: number }>,
): void => {
  headers.append("Set-Cookie", setCookie(ACCESS_COOKIE, tokens.access, Math.floor(tokens.expiresIn)));
  headers.append("Set-Cookie", setCookie(REFRESH_COOKIE, tokens.refresh, 60 * 60 * 24 * 365));
};

/** Clears only the one-time authorization transaction cookie. */
export const appendOpenAuthTransactionClearCookie = (headers: Headers): void => {
  headers.append("Set-Cookie", clearCookie(TRANSACTION_COOKIE));
};

/** Clears all BFF auth cookies without touching legacy account-session credentials. */
export const appendOpenAuthSessionClearCookies = (headers: Headers): void => {
  headers.append("Set-Cookie", clearCookie(ACCESS_COOKIE));
  headers.append("Set-Cookie", clearCookie(REFRESH_COOKIE));
  headers.append("Set-Cookie", clearCookie(TRANSACTION_COOKIE));
};

import { isIndexedDbSupported, setKvValue } from "../indexedDb";

export interface OpenAuthPrincipal {
  userId: string;
}

export type OpenAuthSessionState =
  | { status: "authenticated"; principal: OpenAuthPrincipal }
  | { status: "anonymous" }
  | { status: "unavailable" };

export interface OpenAuthBrowserLocation {
  pathname: string;
  search: string;
  hash: string;
  assign: (url: string) => void;
}

const OPEN_AUTH_PRINCIPAL_PATH = "/api/auth/open/principal";
const OPEN_AUTH_LOGIN_PATH = "/api/auth/open/login";
const OPEN_AUTH_LOGOUT_PATH = "/api/auth/open/logout";
export const OPEN_AUTH_LOGOUT_STORAGE_KEY = "nulldown_openauth_logout_v1";

const isSafePathname = (pathname: string): boolean =>
  pathname.startsWith("/") &&
  !pathname.startsWith("//") &&
  !pathname.includes("\\") &&
  !/%(?:2f|5c)/i.test(pathname);

const asPrincipal = (value: unknown): OpenAuthPrincipal | null => {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as { userId?: unknown }).userId !== "string" ||
    !(value as { userId: string }).userId.trim()
  ) {
    return null;
  }

  return { userId: (value as { userId: string }).userId };
};

/** Distinguishes a real anonymous session from an unavailable account authority. */
export const getOpenAuthSessionState = async (): Promise<OpenAuthSessionState> => {
  try {
    const response = await fetch(OPEN_AUTH_PRINCIPAL_PATH, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) {
      return { status: "unavailable" };
    }
    const principal = asPrincipal(await response.json());
    return principal
      ? { status: "authenticated", principal }
      : { status: "anonymous" };
  } catch {
    return { status: "unavailable" };
  }
};

/** Returns the minimal principal for controls that already have an availability boundary. */
export const getOpenAuthPrincipal = async (): Promise<OpenAuthPrincipal | null> => {
  const state = await getOpenAuthSessionState();
  return state.status === "authenticated" ? state.principal : null;
};

/** Builds a BFF-safe post-login destination from the browser's current location. */
export const getOpenAuthReturnTo = (
  location: Pick<OpenAuthBrowserLocation, "pathname" | "search" | "hash">,
): string => {
  if (!isSafePathname(location.pathname)) {
    return "/";
  }

  const search = location.search.startsWith("?") ? location.search : "";
  const hash = location.hash.startsWith("#") ? location.hash : "";
  return `${location.pathname}${search}${hash}`;
};

/** Starts the same-origin BFF sign-in navigation without exposing credentials to JavaScript. */
export const beginOpenAuthLogin = (
  location: OpenAuthBrowserLocation = window.location,
): void => {
  const returnTo = getOpenAuthReturnTo(location);
  location.assign(`${OPEN_AUTH_LOGIN_PATH}?returnTo=${encodeURIComponent(returnTo)}`);
};

/** Ends the cookie-backed OpenAuth session. Local UI changes only after a successful response. */
export const logoutOpenAuth = async (): Promise<boolean> => {
  try {
    const response = await fetch(OPEN_AUTH_LOGOUT_PATH, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) return false;
    const logoutVersion = `${Date.now()}:${crypto.randomUUID?.() ?? Math.random()}`;
    if (isIndexedDbSupported()) {
      try {
        await setKvValue(OPEN_AUTH_LOGOUT_STORAGE_KEY, logoutVersion);
      } catch {
        // localStorage still broadcasts logout and invalidates the active tab.
      }
    }
    try {
      window.localStorage.setItem(
        OPEN_AUTH_LOGOUT_STORAGE_KEY,
        logoutVersion,
      );
    } catch {
      // The current tab still signs out even if cross-tab notification is unavailable.
    }
    return true;
  } catch {
    return false;
  }
};

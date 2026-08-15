export interface OpenAuthPrincipal {
  userId: string;
}

export interface OpenAuthBrowserLocation {
  pathname: string;
  search: string;
  hash: string;
  assign: (url: string) => void;
}

const OPEN_AUTH_PRINCIPAL_PATH = "/api/auth/open/principal";
const OPEN_AUTH_LOGIN_PATH = "/api/auth/open/login";
const OPEN_AUTH_LOGOUT_PATH = "/api/auth/open/logout";

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

/** Returns the minimal OpenAuth principal or anonymous state from the same-origin BFF. */
export const getOpenAuthPrincipal = async (): Promise<OpenAuthPrincipal | null> => {
  try {
    const response = await fetch(OPEN_AUTH_PRINCIPAL_PATH, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) {
      return null;
    }

    return asPrincipal(await response.json());
  } catch {
    return null;
  }
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
    return response.ok;
  } catch {
    return false;
  }
};

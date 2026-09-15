import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  isCliCredentialBundle,
  type CliCredentialBundleV1,
} from "../../shared/auth/cliDevice";

const REFRESH_WINDOW_MS = 30_000;

/** Safe lifecycle events emitted while a file credential is refreshed. */
export type CliCredentialRefreshEvent = "started" | "completed" | "failed";

/** Settings for a refreshable file-backed account bearer provider. */
export interface FileCliCredentialTokenProviderOptions {
  /** Private credential file created by `nd auth login`. */
  filePath: string;
  /** API origin that the credential must match. */
  baseUrl: string;
  /** Optional fetch implementation for alternate runtimes and tests. */
  fetch?: typeof fetch;
  /** Receives lifecycle events without credential details. */
  onRefresh?: (event: CliCredentialRefreshEvent) => void;
}

/** Refresh request issued by an HTTP client after a rejected account bearer. */
export interface FileCliCredentialBearerRequest {
  forceRefresh?: boolean;
  rejectedToken?: string | null;
}

/** Normalizes and validates an API origin stored in a CLI credential. */
export const normalizeCliCredentialBaseUrl = (value: string): string => {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("CLI auth base URL must be an origin.");
  }
  return url.origin;
};

/** Reads a persisted CLI credential, returning null for missing or malformed data. */
export const readCliCredential = async (
  filePath: string,
): Promise<CliCredentialBundleV1 | null> => {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!isCliCredentialBundle(parsed)) return null;
    return { ...parsed, baseUrl: normalizeCliCredentialBaseUrl(parsed.baseUrl) };
  } catch {
    return null;
  }
};

/** Writes a CLI credential with private directory/file permissions and atomic replacement. */
export const writeCliCredential = async (
  filePath: string,
  credential: CliCredentialBundleV1,
): Promise<void> => {
  if (!isCliCredentialBundle(credential)) {
    throw new Error("Cannot persist an invalid CLI credential.");
  }
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(credential)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
};

/** Removes a local credential even when the remote revoke endpoint is unavailable. */
export const clearCliCredential = async (filePath: string): Promise<void> => {
  await unlink(filePath).catch(() => undefined);
};

/** Returns whether a credential belongs to the selected API origin. */
export const isCliCredentialForBaseUrl = (
  credential: CliCredentialBundleV1 | null,
  baseUrl: string,
): boolean => {
  if (!credential) return false;
  try {
    return credential.baseUrl === normalizeCliCredentialBaseUrl(baseUrl);
  } catch {
    return false;
  }
};

/** Preserves local-only authoring material while replacing server-issued bearer fields. */
export const mergeCliCredentialAuthoring = (
  current: CliCredentialBundleV1,
  replacement: CliCredentialBundleV1,
): CliCredentialBundleV1 => {
  if (!current.authoring) return replacement;
  if (
    current.accountId !== replacement.accountId ||
    current.credentialId !== replacement.credentialId
  ) {
    throw new Error("CLI credential refresh changed the delegated authoring identity.");
  }
  return { ...replacement, authoring: current.authoring };
};

/** Creates a single-process, refreshable account bearer provider backed by one private file. */
export const createFileCliCredentialTokenProvider = ({
  filePath,
  baseUrl,
  fetch: fetchImpl = fetch,
  onRefresh,
}: FileCliCredentialTokenProviderOptions) => {
  const canonicalBaseUrl = normalizeCliCredentialBaseUrl(baseUrl);
  let refreshPromise: Promise<CliCredentialBundleV1> | null = null;

  const readCurrent = async (): Promise<CliCredentialBundleV1> => {
    const credential = await readCliCredential(filePath);
    if (!isCliCredentialForBaseUrl(credential, canonicalBaseUrl)) {
      throw new Error("Nulldown credential is unavailable.");
    }
    if (credential.credentialExpiresAt <= Date.now()) {
      throw new Error("Nulldown credential has expired.");
    }
    return credential;
  };

  const refresh = async (rejectedToken?: string | null): Promise<CliCredentialBundleV1> => {
    if (refreshPromise) return await refreshPromise;

    refreshPromise = (async () => {
      const current = await readCurrent();
      if (
        rejectedToken &&
        current.accessToken !== rejectedToken &&
        current.accessExpiresAt > Date.now() + REFRESH_WINDOW_MS
      ) {
        return current;
      }

      onRefresh?.("started");
      try {
        const response = await fetchImpl(`${canonicalBaseUrl}/api/auth/cli/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: current.refreshToken }),
        });
        const body = await response.json().catch(() => null);
        if (
          !response.ok ||
          !isCliCredentialBundle(body) ||
          !isCliCredentialForBaseUrl(body, canonicalBaseUrl)
        ) {
          throw new Error("Nulldown credential refresh failed.");
        }
        try {
          const replacement = mergeCliCredentialAuthoring(current, body);
          await writeCliCredential(filePath, replacement);
          onRefresh?.("completed");
          return replacement;
        } catch {
          throw new Error("Nulldown credential persistence failed.");
        }
      } catch (error) {
        onRefresh?.("failed");
        if (error instanceof Error && error.message === "Nulldown credential persistence failed.") {
          throw error;
        }
        throw new Error("Nulldown credential refresh failed.");
      }
    })();

    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  };

  return async ({
    forceRefresh = false,
    rejectedToken,
  }: FileCliCredentialBearerRequest = {}): Promise<string | null> => {
    const current = await readCurrent();
    if (
      !forceRefresh &&
      current.accessExpiresAt > Date.now() + REFRESH_WINDOW_MS
    ) {
      return current.accessToken;
    }
    if (
      forceRefresh &&
      rejectedToken &&
      current.accessToken !== rejectedToken &&
      current.accessExpiresAt > Date.now() + REFRESH_WINDOW_MS
    ) {
      return current.accessToken;
    }
    return (await refresh(rejectedToken)).accessToken;
  };
};

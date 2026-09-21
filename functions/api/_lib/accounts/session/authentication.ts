import { NULLDOWN_ACCOUNT_ID_HEADER } from "../../../../../shared/drop/branch";
import type {
  BlobObjectStore,
  SqlMetadataStore,
} from "../../../../../src/server/ports";
import { sanitizeAccountId } from "../identity/records";
import { verifyAccountSessionToken } from "./token";

/** Minimal request surface shared by browser and Workers account-auth routes. */
export interface AccountAuthRequest {
  headers: { get(name: string): string | null };
}

/** Environment bindings used by account authentication services. */
export interface AccountAuthEnv {
  R2_BUCKET?: BlobObjectStore;
  DB?: SqlMetadataStore;
  ACCOUNT_AUTH_SECRET?: string;
  ACCOUNT_AUTH_TOKEN_TTL_MS?: string;
  ALLOW_INSECURE_ACCOUNT_HEADER?: string;
}

/** Reads an insecure development account id header when explicitly enabled. */
export const readRequestAccountId = (
  request: AccountAuthRequest,
): string | null =>
  sanitizeAccountId(request.headers.get(NULLDOWN_ACCOUNT_ID_HEADER));

const readBearerToken = (
  request: AccountAuthRequest,
): { presented: boolean; token: string | null } => {
  const authorization = request.headers.get("Authorization") || "";
  if (!/^Bearer(?:\s|$)/i.test(authorization)) {
    return { presented: false, token: null };
  }

  const token = authorization.slice("Bearer".length).trim();
  return { presented: true, token: token || null };
};

/** Resolves the authenticated account id from bearer token or allowed dev header. */
export const resolveAuthenticatedAccountId = async (
  request: AccountAuthRequest,
  env: AccountAuthEnv,
): Promise<string | null> => {
  const bearer = readBearerToken(request);
  if (bearer.presented) {
    if (!bearer.token) return null;

    const payload = await verifyAccountSessionToken(bearer.token, env);
    if (payload) {
      return payload.accountId;
    }
    return null;
  }

  if (env.ALLOW_INSECURE_ACCOUNT_HEADER !== "1") {
    return null;
  }

  return readRequestAccountId(request);
};

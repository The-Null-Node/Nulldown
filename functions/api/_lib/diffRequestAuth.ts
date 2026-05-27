import type { R2Bucket } from "@cloudflare/workers-types";
import {
  buildDiffSigningPayload,
  DIFF_AUTH_DEFAULT_MAX_SKEW_MS,
  DIFF_CLIENT_ID_HEADER,
  DIFF_SECRET_KID_HEADER,
  DIFF_SIGNATURE_HEADER,
  DIFF_SIGNATURE_PREFIX,
  DIFF_TIMESTAMP_HEADER,
  isTimestampFresh,
} from "../../../shared/drop/diffAuth";
import { readDiffAuthCredential, sanitizeDiffAuthToken } from "./diffAuth";

/** Environment required to verify `/api/diff/:id` request authentication. */
export interface DiffRequestAuthEnv {
  R2_BUCKET?: R2Bucket;
  DIFF_WEBHOOK_SECRET?: string;
  DIFF_AUTH_MAX_SKEW_MS?: string;
}

/** Successful request authentication context for diff transport calls. */
export interface DiffRequestAuthSuccess {
  ok: true;
  mode: "provider" | "env" | "none";
  branchId: string | null;
  clientId: string | null;
}

/** Failed request authentication result with response details. */
export interface DiffRequestAuthFailure {
  ok: false;
  status: number;
  message: string;
  reason: string;
}

/** Authentication result for a diff transport request. */
export type DiffRequestAuthResult =
  | DiffRequestAuthSuccess
  | DiffRequestAuthFailure;

const textEncoder = new TextEncoder();

const resolveMaxSkewMs = (raw: string | undefined): number => {
  if (!raw) {
    return DIFF_AUTH_DEFAULT_MAX_SKEW_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DIFF_AUTH_DEFAULT_MAX_SKEW_MS;
  }

  return parsed;
};

const importHmacKey = async (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

const hexToBytes = (hex: string): Uint8Array | null => {
  if (hex.length % 2 !== 0) {
    return null;
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    const byte = Number.parseInt(hex.slice(index, index + 2), 16);
    if (Number.isNaN(byte)) {
      return null;
    }

    bytes[index / 2] = byte;
  }

  return bytes;
};

const verifyHmacSignature = async (
  secret: string,
  payload: string,
  signatureHeader: string,
): Promise<boolean> => {
  const signatureHex = signatureHeader
    .trim()
    .replace(new RegExp(`^${DIFF_SIGNATURE_PREFIX}`), "");
  const expectedBytes = hexToBytes(signatureHex);
  if (!expectedBytes) {
    return false;
  }

  const key = await importHmacKey(secret);

  return crypto.subtle.verify(
    "HMAC",
    key,
    expectedBytes,
    textEncoder.encode(payload),
  );
};

/** Verifies provider, environment-secret, or local-dev auth for a diff request. */
export const verifyDiffRequestAuth = async (
  env: DiffRequestAuthEnv,
  request: Request,
  dropId: string,
  rawBody: string,
): Promise<DiffRequestAuthResult> => {
  const signature = request.headers.get(DIFF_SIGNATURE_HEADER)?.trim() || "";
  const clientId = sanitizeDiffAuthToken(
    request.headers.get(DIFF_CLIENT_ID_HEADER),
  );
  const kid = sanitizeDiffAuthToken(
    request.headers.get(DIFF_SECRET_KID_HEADER),
  );
  const timestamp = request.headers.get(DIFF_TIMESTAMP_HEADER)?.trim() || "";

  if (signature && clientId && kid && timestamp) {
    if (!env.R2_BUCKET) {
      return {
        ok: false,
        status: 500,
        reason: "bucket_missing",
        message: "R2 bucket binding is required.",
      };
    }

    const maxSkewMs = resolveMaxSkewMs(env.DIFF_AUTH_MAX_SKEW_MS);
    if (!isTimestampFresh(timestamp, Date.now(), maxSkewMs)) {
      return {
        ok: false,
        status: 401,
        reason: "provider_auth_stale_timestamp",
        message: "Provider auth timestamp is stale.",
      };
    }

    const credential = await readDiffAuthCredential(
      env.R2_BUCKET,
      dropId,
      clientId,
      kid,
    );
    if (!credential) {
      return {
        ok: false,
        status: 403,
        reason: "provider_auth_credential_missing",
        message: "Unknown provider auth credential.",
      };
    }

    if (credential.expiresAt !== null && credential.expiresAt < Date.now()) {
      return {
        ok: false,
        status: 403,
        reason: "provider_auth_credential_expired",
        message: "Provider auth credential expired.",
      };
    }

    const path = new URL(request.url).pathname;
    const payload = buildDiffSigningPayload(
      request.method,
      path,
      timestamp,
      rawBody,
    );
    const valid = await verifyHmacSignature(
      credential.secret,
      payload,
      signature,
    );
    if (!valid) {
      return {
        ok: false,
        status: 403,
        reason: "provider_auth_invalid_signature",
        message: "Invalid provider auth signature.",
      };
    }

    return {
      ok: true,
      mode: "provider",
      branchId: credential.branchId,
      clientId,
    };
  }

  if (env.DIFF_WEBHOOK_SECRET) {
    if (!signature) {
      return {
        ok: false,
        status: 401,
        reason: "env_auth_missing_signature",
        message: "Missing webhook signature.",
      };
    }

    const path = new URL(request.url).pathname;
    const validCanonical = timestamp
      ? await verifyHmacSignature(
          env.DIFF_WEBHOOK_SECRET,
          buildDiffSigningPayload(request.method, path, timestamp, rawBody),
          signature,
        )
      : false;

    const validLegacy = await verifyHmacSignature(
      env.DIFF_WEBHOOK_SECRET,
      rawBody,
      signature,
    );

    if (!validCanonical && !validLegacy) {
      return {
        ok: false,
        status: 403,
        reason: "env_auth_invalid_signature",
        message: "Invalid webhook signature.",
      };
    }

    return {
      ok: true,
      mode: "env",
      branchId: null,
      clientId: null,
    };
  }

  return {
    ok: true,
    mode: "none",
    branchId: null,
    clientId,
  };
};

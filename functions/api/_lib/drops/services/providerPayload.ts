import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { decodeDropEnvelope } from "../../../../../shared/drop/codecs/envelope-v1";
import { isDropPayload } from "../../../../../shared/drop/codecs/draft-pack-v1";
import type { DropPayload } from "../../../../../shared/drop/types";
import { decryptProviderEscrowEnvelope } from "../../crypto/envelopes/providerEscrow";
import {
  createCloudflareBlobStore,
  createCloudflareSqlStore,
} from "../../core/platform/cloudflare-storage-adapters";
import { createDropIdentityRepository } from "../identity/id";
import type { AccountAuthRequest } from "../../accounts/session/auth";
import {
  canReadRoot,
  resolveRootReadAuthorization,
} from "../../security/readAuthorization";

/** Cloudflare bindings needed to read a provider-readable drop payload. */
export interface CloudflareProviderPayloadBindings {
  /** Canonical drop storage. */
  R2_BUCKET: R2Bucket;
  /** Optional index used to resolve aliases and short ids. */
  DB?: D1Database;
  /** Provider escrow private key used to decrypt provider-readable envelopes. */
  PROVIDER_ENCRYPTION_PRIVATE_JWK?: string;
  /** Secret used to validate account bearer sessions for authorized reads. */
  ACCOUNT_AUTH_SECRET?: string;
  /** Optional account session lifetime configuration. */
  ACCOUNT_AUTH_TOKEN_TTL_MS?: string;
  /** Explicit development-only account-header opt-in. */
  ALLOW_INSECURE_ACCOUNT_HEADER?: string;
}

/** Canonical payload material read by the provider for a requested drop id. */
export interface ProviderReadableDropPayload {
  /** Canonical drop id after alias resolution. */
  dropId: string;
  /** Provider-readable drop payload. */
  payload: DropPayload;
}

/** Authorization applied before a provider-readable drop object is accessed. */
export type ProviderPayloadReadAuthorization =
  | {
      /** Authorize a separately targeted root from the authenticated request. */
      kind: "request";
      /** Request identity used with the trusted root projection. */
      request: AccountAuthRequest;
    }
  | {
      /** Reuse authorization already completed for this exact canonical root. */
      kind: "preauthorized";
      /** Canonical root id authorized by the caller boundary. */
      canonicalDropId: string;
    };

const readText = async (
  object: { text: () => Promise<string> } | null,
): Promise<string | null> => {
  if (!object) return null;
  try {
    return await object.text();
  } catch {
    return null;
  }
};

/** Reads a canonical payload when storage and provider escrow access permit it. */
export const readProviderDropPayload = async (
  bindings: CloudflareProviderPayloadBindings,
  requestedDropId: string,
  authorization?: ProviderPayloadReadAuthorization,
): Promise<ProviderReadableDropPayload | null> => {
  const blobs = createCloudflareBlobStore(bindings.R2_BUCKET);
  const sql = createCloudflareSqlStore(bindings.DB);
  const dropId = authorization?.kind === "preauthorized"
    ? authorization.canonicalDropId === requestedDropId
      ? requestedDropId
      : null
    : await createDropIdentityRepository({ blobs, sql })
        .resolveRemoteDropIdForReadRequest(requestedDropId);
  if (!dropId) return null;

  if (authorization?.kind === "request") {
    const decision = await resolveRootReadAuthorization(
      authorization.request,
      {
        R2_BUCKET: blobs,
        DB: sql,
        ACCOUNT_AUTH_SECRET: bindings.ACCOUNT_AUTH_SECRET,
        ACCOUNT_AUTH_TOKEN_TTL_MS: bindings.ACCOUNT_AUTH_TOKEN_TTL_MS,
        ALLOW_INSECURE_ACCOUNT_HEADER: bindings.ALLOW_INSECURE_ACCOUNT_HEADER,
      },
      dropId,
    );
    if (!canReadRoot(decision)) return null;
  }

  const raw = await readText(await bindings.R2_BUCKET.get(dropId));
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { dropId, payload: { content: raw } };
  }

  if (isDropPayload(parsed)) return { dropId, payload: parsed };
  const envelope = decodeDropEnvelope(parsed);
  if (envelope && bindings.PROVIDER_ENCRYPTION_PRIVATE_JWK) {
    try {
      return {
        dropId,
        payload: await decryptProviderEscrowEnvelope(
          envelope,
          bindings.PROVIDER_ENCRYPTION_PRIVATE_JWK,
        ),
      };
    } catch {
      return null;
    }
  }
  return null;
};

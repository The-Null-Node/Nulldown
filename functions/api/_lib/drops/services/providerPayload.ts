import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import {
  isDropEnvelopeV1,
  isDropPayload,
  type DropPayload,
} from "../../../../../shared/drop/types";
import { decryptProviderEscrowEnvelope } from "../../crypto/envelopes/providerEscrow";
import {
  createCloudflareBlobStore,
  createCloudflareSqlStore,
} from "../../core/platform/cloudflarePorts";
import { createDropIdentityRepository } from "../identity/id";

/** Cloudflare bindings needed to read a provider-readable drop payload. */
export interface CloudflareProviderPayloadBindings {
  /** Canonical drop storage. */
  R2_BUCKET: R2Bucket;
  /** Optional index used to resolve aliases and short ids. */
  DB?: D1Database;
  /** Provider escrow private key used to decrypt provider-readable envelopes. */
  PROVIDER_ENCRYPTION_PRIVATE_JWK?: string;
}

/** Canonical payload material read by the provider for a requested drop id. */
export interface ProviderReadableDropPayload {
  /** Canonical drop id after alias resolution. */
  dropId: string;
  /** Provider-readable drop payload. */
  payload: DropPayload;
}

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
): Promise<ProviderReadableDropPayload | null> => {
  const identities = createDropIdentityRepository({
    blobs: createCloudflareBlobStore(bindings.R2_BUCKET),
    sql: createCloudflareSqlStore(bindings.DB),
  });
  const dropId = await identities.resolveRemoteDropId(requestedDropId);
  if (!dropId) return null;

  const raw = await readText(await bindings.R2_BUCKET.get(dropId));
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { dropId, payload: { content: raw } };
  }

  if (isDropPayload(parsed)) return { dropId, payload: parsed };
  if (isDropEnvelopeV1(parsed) && bindings.PROVIDER_ENCRYPTION_PRIVATE_JWK) {
    try {
      return {
        dropId,
        payload: await decryptProviderEscrowEnvelope(
          parsed,
          bindings.PROVIDER_ENCRYPTION_PRIVATE_JWK,
        ),
      };
    } catch {
      return null;
    }
  }
  return null;
};

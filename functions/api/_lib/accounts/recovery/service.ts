import {
  parseEncryptedAccountRecoveryPackage,
  serializeAccountRecoveryPackage,
  type EncryptedAccountRecoveryPackageV1,
} from "../../../../../shared/auth/recovery";
import type { VoidBlobStore, VoidSqlStore } from "../../../../../src/server/ports";
import { readAccountRecord, resolveAuthenticatedAccountId } from "../session/auth";
import {
  isSameOriginOpenAuthRequest,
  resolveOpenAuthRequestIdentity,
  type OpenAuthRequestIdentity,
} from "../openAuth/service";
import {
  readAccountBinding,
} from "../binding/repository";
import {
  fingerprintAccountSigningKey,
  verifyAccountSignature,
  type AccountBindingEnvironment,
} from "../binding/service";
import {
  advanceRecoveryPackage,
  readLatestRecoveryPackageForUser,
  readRecoveryPackageForAccount,
} from "./repository";

const RECOVERY_OBJECT_PREFIX = "__account_recovery__/packages/";
const textEncoder = new TextEncoder();

const responseJson = (
  body: unknown,
  status: number,
  identity?: OpenAuthRequestIdentity,
): Response => {
  const headers = new Headers(identity?.responseHeaders);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
};

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const fromBase64Url = (value: string): Uint8Array | null => {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
};

const ciphertextDigest = async (ciphertext: string): Promise<string> =>
  `sha256:${toBase64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", textEncoder.encode(ciphertext)),
    ),
  )}`;

const parseStoredPackage = async (
  bucket: VoidBlobStore,
  objectKey: string,
): Promise<EncryptedAccountRecoveryPackageV1 | null> => {
  const object = await bucket.get(objectKey);
  if (!object) return null;
  try {
    return parseEncryptedAccountRecoveryPackage(await object.json<unknown>());
  } catch {
    return null;
  }
};

/** Downloads only the package owned by the verified OpenAuth user. */
export const readRecoveryPackageResponse = async (
  env: AccountBindingEnvironment,
  request: Request,
): Promise<Response> => {
  const identity = await resolveOpenAuthRequestIdentity(env, request);
  if (identity instanceof Response) return identity;
  if (!env.R2_BUCKET) {
    return responseJson({ error: "recovery_storage_unavailable" }, 503, identity);
  }

  const row = await readLatestRecoveryPackageForUser(identity.db, identity.userId);
  if (!row) return responseJson({ available: false }, 404, identity);
  const stored = await parseStoredPackage(env.R2_BUCKET, row.object_key);
  if (
    !stored ||
    stored.metadata.userId !== identity.userId ||
    stored.metadata.accountId !== row.account_id ||
    stored.metadata.revision !== row.revision ||
    stored.metadata.ciphertextDigest !== row.ciphertext_digest ||
    stored.metadata.ciphertextLength !== row.ciphertext_length
  ) {
    return responseJson({ error: "recovery_package_unavailable" }, 503, identity);
  }
  return responseJson({ available: true, package: stored }, 200, identity);
};

/** Stores an opaque encrypted package after matching both user and V1 account authority. */
export const writeRecoveryPackageResponse = async (
  env: AccountBindingEnvironment,
  request: Request,
): Promise<Response> => {
  const identity = await resolveOpenAuthRequestIdentity(env, request);
  if (identity instanceof Response) return identity;
  if (!isSameOriginOpenAuthRequest(request, identity.origin)) {
    return responseJson({ error: "invalid_origin" }, 403, identity);
  }
  if (!env.R2_BUCKET) {
    return responseJson({ error: "recovery_storage_unavailable" }, 503, identity);
  }
  if (!env.ACCOUNT_AUTH_SECRET) {
    return responseJson({ error: "account_auth_unavailable" }, 503, identity);
  }
  if (!request.headers.get("Authorization")?.startsWith("Bearer ")) {
    return responseJson({ error: "account_auth_required" }, 401, identity);
  }
  const accountId = await resolveAuthenticatedAccountId(request, env);
  if (!accountId) return responseJson({ error: "account_auth_required" }, 401, identity);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return responseJson({ error: "invalid_recovery_package" }, 400, identity);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return responseJson({ error: "invalid_recovery_package" }, 400, identity);
  }
  const requestBody = body as Record<string, unknown>;
  const encryptedPackage = parseEncryptedAccountRecoveryPackage(requestBody.package);
  const signature = requestBody.signature;
  if (
    !encryptedPackage ||
    typeof signature !== "string" ||
    Object.keys(requestBody).length !== 2
  ) {
    return responseJson({ error: "invalid_recovery_package" }, 400, identity);
  }
  const metadata = encryptedPackage.metadata;
  if (metadata.userId !== identity.userId || metadata.accountId !== accountId) {
    return responseJson({ error: "recovery_authority_mismatch" }, 403, identity);
  }
  const binding = await readAccountBinding(identity.db, accountId);
  if (
    !binding ||
    binding.user_id !== identity.userId ||
    binding.signing_key_fingerprint !== metadata.signingKeyFingerprint
  ) {
    return responseJson({ error: "account_binding_required" }, 409, identity);
  }
  const account = await readAccountRecord(
    env.R2_BUCKET,
    accountId,
    identity.db as unknown as VoidSqlStore,
  );
  if (
    !account ||
    (await fingerprintAccountSigningKey(account.signingPublicJwk)) !==
      binding.signing_key_fingerprint ||
    !(await verifyAccountSignature(
      account.signingPublicJwk,
      serializeAccountRecoveryPackage(encryptedPackage),
      signature,
    ))
  ) {
    return responseJson({ error: "invalid_recovery_signature" }, 401, identity);
  }

  const ciphertextBytes = fromBase64Url(encryptedPackage.ciphertext);
  const digest = await ciphertextDigest(encryptedPackage.ciphertext);
  if (
    !ciphertextBytes ||
    ciphertextBytes.byteLength !== metadata.ciphertextLength ||
    digest !== metadata.ciphertextDigest
  ) {
    return responseJson({ error: "invalid_recovery_package" }, 400, identity);
  }

  const current = await readRecoveryPackageForAccount(identity.db, accountId);
  const metadataJson = JSON.stringify(metadata);
  if (
    current?.user_id === identity.userId &&
    current.ciphertext_digest === digest &&
    current.revision === metadata.revision &&
    current.ciphertext_length === metadata.ciphertextLength &&
    current.metadata_json === metadataJson
  ) {
    return responseJson({ stored: true, accountId, revision: metadata.revision }, 200, identity);
  }
  const expectedRevision = current?.revision ?? 0;
  if (metadata.revision !== expectedRevision + 1) {
    return responseJson(
      { error: "recovery_revision_conflict", currentRevision: expectedRevision },
      409,
      identity,
    );
  }

  const objectKey = `${RECOVERY_OBJECT_PREFIX}${accountId}/${metadata.revision}-${digest.slice("sha256:".length)}.json`;
  const serializedPackage = JSON.stringify(encryptedPackage);
  const storedObject = await env.R2_BUCKET.put(objectKey, serializedPackage, {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (!storedObject) {
    const existingObject = await env.R2_BUCKET.get(objectKey);
    if (!existingObject || (await existingObject.text()) !== serializedPackage) {
      return responseJson({ error: "recovery_object_conflict" }, 409, identity);
    }
  }
  const now = Date.now();
  const advanced = await advanceRecoveryPackage(
    identity.db,
    {
      account_id: accountId,
      user_id: identity.userId,
      revision: metadata.revision,
      object_key: objectKey,
      ciphertext_digest: digest,
      ciphertext_length: metadata.ciphertextLength,
      metadata_json: metadataJson,
      created_at: current?.created_at ?? now,
      updated_at: now,
    },
    expectedRevision,
  );
  if (!advanced) {
    await env.R2_BUCKET.delete(objectKey);
    return responseJson(
      { error: "recovery_revision_conflict", currentRevision: expectedRevision },
      409,
      identity,
    );
  }
  return responseJson({ stored: true, accountId, revision: metadata.revision }, 201, identity);
};

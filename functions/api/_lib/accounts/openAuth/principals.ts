import type { D1Database } from "@cloudflare/workers-types";

import type { VerifiedOpenAuthPrincipal } from "./authority";

interface IdentityRow {
  user_id: string;
}

const identityKey = (principal: VerifiedOpenAuthPrincipal) => ({
  issuer: principal.issuer,
  providerKey: principal.principal.type,
  providerSubject: principal.principal.properties.userId,
});

/** Creates the application principal binding once, or returns its stable internal user id. */
export const resolveOrCreateOpenAuthUser = async (
  db: D1Database,
  principal: VerifiedOpenAuthPrincipal,
): Promise<string | null> => {
  const key = identityKey(principal);
  const userId = principal.principal.properties.userId;
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO auth_users (user_id, created_at, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO NOTHING`,
    )
    .bind(userId, now, now)
    .run();
  await db
    .prepare(
      `INSERT INTO auth_external_identities (
         issuer, provider_key, provider_subject, user_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(issuer, provider_key, provider_subject) DO NOTHING`,
    )
    .bind(key.issuer, key.providerKey, key.providerSubject, userId, now, now)
    .run();

  const identity = await db
    .prepare(
      `SELECT user_id
       FROM auth_external_identities
       WHERE issuer = ? AND provider_key = ? AND provider_subject = ?`,
    )
    .bind(key.issuer, key.providerKey, key.providerSubject)
    .first<IdentityRow>();
  return identity?.user_id === userId ? userId : null;
};

/** Resolves an already-established BFF principal binding without creating any legacy records. */
export const readOpenAuthUser = async (
  db: D1Database,
  principal: VerifiedOpenAuthPrincipal,
): Promise<string | null> => {
  const key = identityKey(principal);
  const expectedUserId = principal.principal.properties.userId;
  const identity = await db
    .prepare(
      `SELECT user_id
       FROM auth_external_identities
       WHERE issuer = ? AND provider_key = ? AND provider_subject = ?`,
    )
    .bind(key.issuer, key.providerKey, key.providerSubject)
    .first<IdentityRow>();
  return identity?.user_id === expectedUserId ? expectedUserId : null;
};

import type { D1Database } from "@cloudflare/workers-types";

import type { VerifiedOpenAuthPrincipal } from "./authority";

interface UserRow {
  user_id: string;
}

/** Verifies an issuer-owned internal user exists without manufacturing principal records. */
export const readOpenAuthUser = async (
  db: D1Database,
  principal: VerifiedOpenAuthPrincipal,
): Promise<string | null> => {
  const expectedUserId = principal.principal.properties.userId;
  const user = await db
    .prepare(
      `SELECT user_id
       FROM auth_users
       WHERE user_id = ?`,
    )
    .bind(expectedUserId)
    .first<UserRow>();
  return user?.user_id === expectedUserId ? expectedUserId : null;
};

import type { D1Database } from "@cloudflare/workers-types";

interface CallbackTransactionRow {
  return_to: string;
}

/** Persists one callback state hash; raw state, nonce, and verifier remain in the BFF cookie. */
export const createOpenAuthCallbackTransaction = async (
  db: D1Database,
  input: Readonly<{ stateHash: string; returnTo: string; expiresAt: number }>,
): Promise<void> => {
  const createdAt = Date.now();
  await db
    .prepare(
      `INSERT INTO auth_callback_transactions (
         state_hash, return_to, created_at, expires_at
       ) VALUES (?, ?, ?, ?)`,
    )
    .bind(input.stateHash, input.returnTo, createdAt, input.expiresAt)
    .run();
};

/** Atomically consumes one unexpired callback transaction before any authority code exchange. */
export const consumeOpenAuthCallbackTransaction = async (
  db: D1Database,
  stateHash: string,
  now = Date.now(),
): Promise<string | null> => {
  const consumed = await db
    .prepare(
      `DELETE FROM auth_callback_transactions
       WHERE state_hash = ? AND expires_at > ?
       RETURNING return_to`,
    )
    .bind(stateHash, now)
    .first<CallbackTransactionRow>();
  return consumed?.return_to ?? null;
};

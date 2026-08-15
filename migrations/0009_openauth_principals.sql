-- Additive recoverable-user principal records. Legacy account and branch authority remains separate.
CREATE TABLE IF NOT EXISTS auth_users (
  user_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_external_identities (
  issuer TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES auth_users(user_id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (issuer, provider_key, provider_subject)
);

CREATE INDEX IF NOT EXISTS idx_auth_external_identities_user_id
  ON auth_external_identities(user_id);

-- State is hashed before persistence; verifier and nonce remain only in the short-lived BFF cookie.
CREATE TABLE IF NOT EXISTS auth_callback_transactions (
  state_hash TEXT PRIMARY KEY,
  return_to TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_callback_transactions_expires_at
  ON auth_callback_transactions(expires_at);

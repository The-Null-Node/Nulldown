-- Bind recoverable OpenAuth users to current V1 accounts through one-time signed challenges.
CREATE TABLE IF NOT EXISTS auth_account_bindings (
  account_id TEXT PRIMARY KEY REFERENCES accounts(account_id),
  user_id TEXT NOT NULL REFERENCES auth_users(user_id),
  signing_key_fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_account_bindings_user_id
  ON auth_account_bindings(user_id, created_at);

CREATE TABLE IF NOT EXISTS auth_account_binding_challenges (
  challenge_id TEXT PRIMARY KEY,
  nonce_hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES auth_users(user_id),
  account_id TEXT NOT NULL REFERENCES accounts(account_id),
  origin TEXT NOT NULL,
  signing_key_fingerprint TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_auth_account_binding_challenges_expiry
  ON auth_account_binding_challenges(expires_at);

-- D1 keeps the monotonic head; immutable ciphertext bodies live in R2.
CREATE TABLE IF NOT EXISTS auth_account_recovery_packages (
  account_id TEXT PRIMARY KEY REFERENCES auth_account_bindings(account_id),
  user_id TEXT NOT NULL REFERENCES auth_users(user_id),
  revision INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  ciphertext_digest TEXT NOT NULL,
  ciphertext_length INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_account_recovery_packages_user_id
  ON auth_account_recovery_packages(user_id, updated_at DESC);

-- Browser-mediated CLI authorization with refreshable account-scoped credentials.
CREATE TABLE IF NOT EXISTS auth_cli_device_tickets (
  ticket_id TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code_hash TEXT NOT NULL UNIQUE,
  client_public_jwk_json TEXT NOT NULL,
  client_name TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_user_id TEXT REFERENCES auth_users(user_id),
  approved_account_id TEXT REFERENCES auth_account_bindings(account_id),
  approved_at INTEGER,
  redeemed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_auth_cli_device_tickets_expiry
  ON auth_cli_device_tickets(expires_at);

CREATE INDEX IF NOT EXISTS idx_auth_cli_device_tickets_approval
  ON auth_cli_device_tickets(approved_user_id, approved_at);

CREATE TABLE IF NOT EXISTS auth_cli_credentials (
  credential_id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL UNIQUE REFERENCES auth_cli_device_tickets(ticket_id),
  user_id TEXT NOT NULL REFERENCES auth_users(user_id),
  account_id TEXT NOT NULL REFERENCES auth_account_bindings(account_id),
  refresh_token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_auth_cli_credentials_account
  ON auth_cli_credentials(account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_cli_credentials_expiry
  ON auth_cli_credentials(expires_at);

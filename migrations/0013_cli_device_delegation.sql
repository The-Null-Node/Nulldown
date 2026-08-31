-- Add public delegated-authoring data to the existing one-time CLI ticket.
ALTER TABLE auth_cli_device_tickets ADD COLUMN authoring_requested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auth_cli_device_tickets ADD COLUMN delegate_signing_public_jwk_json TEXT;
ALTER TABLE auth_cli_device_tickets ADD COLUMN credential_id TEXT;
ALTER TABLE auth_cli_device_tickets ADD COLUMN credential_expires_at INTEGER;
ALTER TABLE auth_cli_device_tickets ADD COLUMN device_delegation_json TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_cli_device_tickets_credential_id
  ON auth_cli_device_tickets(credential_id)
  WHERE credential_id IS NOT NULL;

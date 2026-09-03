-- Account-owned, non-sensitive preferences use one independently versioned row per field.
CREATE TABLE IF NOT EXISTS auth_user_preferences (
  user_id TEXT NOT NULL REFERENCES auth_users(user_id),
  preference_key TEXT NOT NULL CHECK (preference_key IN (
    'theme', 'typeface', 'syntaxMode', 'shareVisibilityDefault'
  )),
  preference_value TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, preference_key)
);

CREATE TABLE IF NOT EXISTS invitation_activation_tokens (
  invitation_id TEXT PRIMARY KEY REFERENCES invitations(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_invitation_activation_expires ON invitation_activation_tokens(expires_at);

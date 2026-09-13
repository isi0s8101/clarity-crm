-- Clarity CRM v1.3 — Integration Manager foundations, strictly additive.
-- External providers remain adapters. Clarity CRM business data stays authoritative in
-- existing CRM / Inbox / Planning / Documents structures.

CREATE TABLE IF NOT EXISTS integration_connections (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider ~ '^[a-z0-9][a-z0-9._:-]{0,63}$'),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','connecting','connected','degraded','reauth_required','rate_limited','error','disabled','revoked'
  )),
  owner_admin_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
  sync_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error_code TEXT NOT NULL DEFAULT '',
  last_error_message TEXT NOT NULL DEFAULT '',
  last_success_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_integration_connection_tenant_id UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_integration_connections_lookup
  ON integration_connections(tenant_id, provider, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS integration_credentials (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  secret_kind TEXT NOT NULL CHECK (secret_kind ~ '^[a-z][a-z0-9._:-]{0,63}$'),
  algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm' CHECK (algorithm = 'aes-256-gcm'),
  key_id TEXT NOT NULL CHECK (char_length(key_id) BETWEEN 1 AND 120),
  iv_b64 TEXT NOT NULL,
  auth_tag_b64 TEXT NOT NULL,
  ciphertext_b64 TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ,
  last_rotated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_integration_credentials_connection
    FOREIGN KEY (tenant_id, connection_id)
    REFERENCES integration_connections(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT uq_integration_credential_kind UNIQUE (tenant_id, connection_id, secret_kind)
);

CREATE INDEX IF NOT EXISTS idx_integration_credentials_expiry
  ON integration_credentials(tenant_id, connection_id, expires_at);

CREATE TABLE IF NOT EXISTS integration_oauth_transactions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  initiated_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  state_hash TEXT NOT NULL UNIQUE CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  pkce_challenge TEXT NOT NULL,
  pkce_verifier_key_id TEXT NOT NULL,
  pkce_verifier_iv_b64 TEXT NOT NULL,
  pkce_verifier_auth_tag_b64 TEXT NOT NULL,
  pkce_verifier_ciphertext_b64 TEXT NOT NULL,
  nonce_hash TEXT NOT NULL DEFAULT '' CHECK (nonce_hash = '' OR nonce_hash ~ '^[0-9a-f]{64}$'),
  redirect_uri TEXT NOT NULL,
  requested_scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_integration_oauth_connection
    FOREIGN KEY (tenant_id, connection_id)
    REFERENCES integration_connections(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_integration_oauth_expiry
  ON integration_oauth_transactions(tenant_id, connection_id, expires_at);

CREATE TABLE IF NOT EXISTS integration_mappings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type ~ '^[a-z][a-z0-9._:-]{0,79}$'),
  direction TEXT NOT NULL DEFAULT 'pull_only' CHECK (direction IN ('pull_only','push_only','bidirectional')),
  clarity_type TEXT NOT NULL DEFAULT '',
  conflict_policy TEXT NOT NULL DEFAULT 'manual' CHECK (conflict_policy IN ('manual','external_wins','clarity_wins')),
  mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_integration_mapping_connection
    FOREIGN KEY (tenant_id, connection_id)
    REFERENCES integration_connections(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT uq_integration_mapping_resource UNIQUE (tenant_id, connection_id, resource_type)
);

CREATE TABLE IF NOT EXISTS integration_sync_cursors (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('pull','push')),
  cursor_value TEXT NOT NULL DEFAULT '',
  watermark_at TIMESTAMPTZ,
  cursor_version INTEGER NOT NULL DEFAULT 1 CHECK (cursor_version >= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_integration_cursor_connection
    FOREIGN KEY (tenant_id, connection_id)
    REFERENCES integration_connections(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT uq_integration_cursor UNIQUE (tenant_id, connection_id, resource_type, direction)
);

CREATE TABLE IF NOT EXISTS integration_sync_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('pull','push')),
  trigger_kind TEXT NOT NULL DEFAULT 'manual' CHECK (trigger_kind IN ('initial','manual','scheduled','retry','webhook')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','success','partial','retrying','failed','cancelled')),
  job_id TEXT,
  correlation_id TEXT NOT NULL,
  cursor_before TEXT NOT NULL DEFAULT '',
  cursor_after TEXT NOT NULL DEFAULT '',
  received INTEGER NOT NULL DEFAULT 0 CHECK (received >= 0),
  created_count INTEGER NOT NULL DEFAULT 0 CHECK (created_count >= 0),
  updated_count INTEGER NOT NULL DEFAULT 0 CHECK (updated_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_integration_run_connection
    FOREIGN KEY (tenant_id, connection_id)
    REFERENCES integration_connections(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_integration_sync_runs_lookup
  ON integration_sync_runs(tenant_id, connection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_integration_sync_runs_status
  ON integration_sync_runs(status, created_at);

CREATE TABLE IF NOT EXISTS integration_resource_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  external_id TEXT NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 1024),
  clarity_kind TEXT NOT NULL,
  clarity_id TEXT NOT NULL,
  external_version TEXT NOT NULL DEFAULT '',
  external_etag TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'integration' CHECK (origin IN ('integration','clarity')),
  external_deleted_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_integration_resource_connection
    FOREIGN KEY (tenant_id, connection_id)
    REFERENCES integration_connections(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT uq_integration_external_resource UNIQUE (tenant_id, connection_id, resource_type, external_id)
);

CREATE INDEX IF NOT EXISTS idx_integration_resource_links_clarity
  ON integration_resource_links(tenant_id, clarity_kind, clarity_id);

CREATE TABLE IF NOT EXISTS integration_health_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','error')),
  code TEXT NOT NULL CHECK (char_length(code) BETWEEN 1 AND 120),
  message TEXT NOT NULL CHECK (char_length(message) BETWEEN 1 AND 2000),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_integration_health_connection
    FOREIGN KEY (tenant_id, connection_id)
    REFERENCES integration_connections(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_integration_health_lookup
  ON integration_health_events(tenant_id, connection_id, created_at DESC);

CREATE TABLE IF NOT EXISTS integration_rate_limits (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  provider_bucket TEXT NOT NULL DEFAULT 'default',
  blocked_until TIMESTAMPTZ,
  retry_after_seconds INTEGER CHECK (retry_after_seconds IS NULL OR retry_after_seconds >= 0),
  remaining INTEGER CHECK (remaining IS NULL OR remaining >= 0),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_integration_rate_limit_connection
    FOREIGN KEY (tenant_id, connection_id)
    REFERENCES integration_connections(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT uq_integration_rate_limit UNIQUE (tenant_id, connection_id, provider_bucket)
);

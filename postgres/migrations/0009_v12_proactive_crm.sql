-- Clarity CRM v1.2 — proactive CRM foundations, strictly additive.
-- Business objects remain in crm_records. Specialized tables below are limited
-- to invariants that require database-level concurrency, isolation or history.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS planning_reservations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  appointment_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('user', 'team')),
  resource_id TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  blocked_starts_at TIMESTAMPTZ NOT NULL,
  blocked_ends_at TIMESTAMPTZ NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'cancelled')),
  idempotency_key TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_planning_reservation_appointment
    FOREIGN KEY (tenant_id, appointment_id)
    REFERENCES crm_records(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_planning_reservation_interval CHECK (ends_at > starts_at),
  CONSTRAINT chk_planning_reservation_blocked_interval CHECK (blocked_ends_at > blocked_starts_at),
  CONSTRAINT uq_planning_reservation_appointment UNIQUE (tenant_id, appointment_id),
  CONSTRAINT uq_planning_reservation_idempotency UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_planning_reservation_lookup
  ON planning_reservations(tenant_id, resource_kind, resource_id, starts_at, ends_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ex_planning_reservation_no_overlap'
  ) THEN
    ALTER TABLE planning_reservations
      ADD CONSTRAINT ex_planning_reservation_no_overlap
      EXCLUDE USING gist (
        tenant_id WITH =,
        resource_kind WITH =,
        resource_id WITH =,
        tstzrange(blocked_starts_at, blocked_ends_at, '[)') WITH &&
      ) WHERE (status = 'booked');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS crm_publications (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL,
  configuration_id TEXT NOT NULL,
  publication_kind TEXT NOT NULL CHECK (publication_kind IN ('form', 'appointment_booking')),
  object_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  exposed_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_crm_publication_team
    FOREIGN KEY (tenant_id, team_id) REFERENCES teams(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_publication_configuration
    FOREIGN KEY (tenant_id, configuration_id)
    REFERENCES crm_configurations(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_crm_publication_tenant_status
  ON crm_publications(tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS crm_public_submission_receipts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  publication_id TEXT NOT NULL REFERENCES crm_publications(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  record_id TEXT,
  response_status INTEGER NOT NULL DEFAULT 201,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_crm_public_submission_idempotency
    UNIQUE (tenant_id, publication_id, idempotency_key),
  CONSTRAINT fk_crm_public_submission_record
    FOREIGN KEY (tenant_id, record_id)
    REFERENCES crm_records(tenant_id, id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS crm_public_rate_limits (
  publication_id TEXT NOT NULL REFERENCES crm_publications(id) ON DELETE CASCADE,
  bucket_hash TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 1 CHECK (request_count >= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (publication_id, bucket_hash, window_start)
);

CREATE TABLE IF NOT EXISTS crm_inbox_conversations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  related_record_id TEXT,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'closed', 'archived')),
  unread_count INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_crm_inbox_conversation_team
    FOREIGN KEY (tenant_id, team_id) REFERENCES teams(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_inbox_conversation_record
    FOREIGN KEY (tenant_id, related_record_id)
    REFERENCES crm_records(tenant_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_crm_inbox_conversation_lookup
  ON crm_inbox_conversations(tenant_id, team_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_inbox_conversation_record
  ON crm_inbox_conversations(tenant_id, related_record_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS crm_inbox_messages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES crm_inbox_conversations(id) ON DELETE CASCADE,
  sender_kind TEXT NOT NULL CHECK (sender_kind IN ('internal', 'external', 'system')),
  sender_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'internal')),
  body TEXT NOT NULL CHECK (octet_length(body) <= 65536),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crm_inbox_message_lookup
  ON crm_inbox_messages(tenant_id, conversation_id, created_at ASC);

CREATE TABLE IF NOT EXISTS crm_merge_ledger (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  primary_record_id TEXT NOT NULL,
  secondary_record_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  preview JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolution JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_crm_merge_distinct_records CHECK (primary_record_id <> secondary_record_id),
  CONSTRAINT fk_crm_merge_primary
    FOREIGN KEY (tenant_id, primary_record_id)
    REFERENCES crm_records(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_merge_secondary
    FOREIGN KEY (tenant_id, secondary_record_id)
    REFERENCES crm_records(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_crm_merge_ledger_lookup
  ON crm_merge_ledger(tenant_id, created_at DESC);

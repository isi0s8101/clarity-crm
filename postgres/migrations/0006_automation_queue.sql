-- File durable d'automatisation et reçus d'idempotence.
-- Les jobs sont claimés par le worker via FOR UPDATE SKIP LOCKED.

CREATE TABLE IF NOT EXISTS automation_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  automation_id TEXT NOT NULL DEFAULT '',
  event TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  correlation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'retrying', 'success', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  locked_at TIMESTAMPTZ,
  locked_by TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_jobs_idempotency
  ON automation_jobs(tenant_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_automation_jobs_available
  ON automation_jobs(status, available_at, created_at);
CREATE INDEX IF NOT EXISTS idx_automation_jobs_tenant_created
  ON automation_jobs(tenant_id, created_at);

CREATE TABLE IF NOT EXISTS automation_action_receipts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES automation_jobs(id) ON DELETE CASCADE,
  automation_id TEXT NOT NULL,
  action_index INTEGER NOT NULL CHECK (action_index >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_automation_action_receipt UNIQUE (tenant_id, job_id, automation_id, action_index)
);

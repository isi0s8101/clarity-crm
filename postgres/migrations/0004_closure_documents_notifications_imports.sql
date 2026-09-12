CREATE TABLE IF NOT EXISTS crm_documents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL REFERENCES crm_records(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL,
  original_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 10485760),
  sha256 TEXT NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_documents_storage_key ON crm_documents(storage_key);
CREATE INDEX IF NOT EXISTS idx_crm_documents_record ON crm_documents(tenant_id, record_id, status, created_at);

CREATE TABLE IF NOT EXISTS crm_notifications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  resource_type TEXT NOT NULL DEFAULT '',
  resource_id TEXT NOT NULL DEFAULT '',
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_crm_notifications_recipient ON crm_notifications(tenant_id, recipient_id, read_at, created_at);

CREATE TABLE IF NOT EXISTS crm_import_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  object_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'partial', 'rejected')),
  source_name TEXT NOT NULL,
  total_rows INTEGER NOT NULL CHECK (total_rows >= 0),
  imported_rows INTEGER NOT NULL CHECK (imported_rows >= 0),
  rejected_rows INTEGER NOT NULL CHECK (rejected_rows >= 0),
  report TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_crm_import_jobs_tenant_created ON crm_import_jobs(tenant_id, created_at);

ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS correlation_id TEXT NOT NULL DEFAULT '';
ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS depth INTEGER NOT NULL DEFAULT 0 CHECK (depth >= 0 AND depth <= 8);
ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1 AND attempt <= 5);
CREATE INDEX IF NOT EXISTS idx_automation_runs_correlation ON automation_runs(tenant_id, correlation_id, created_at);

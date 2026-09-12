CREATE TABLE IF NOT EXISTS crm_ocr_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES crm_documents(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  language TEXT NOT NULL DEFAULT 'eng' CHECK (language IN ('eng', 'fra')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0 AND attempt <= 2),
  correlation_id TEXT NOT NULL,
  error TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ocr_jobs_queue ON crm_ocr_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_ocr_jobs_document ON crm_ocr_jobs(tenant_id, document_id, created_at);

CREATE TABLE IF NOT EXISTS crm_ocr_results (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES crm_documents(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES crm_ocr_jobs(id) ON DELETE CASCADE,
  engine TEXT NOT NULL,
  extracted_text TEXT NOT NULL,
  corrected_text TEXT NOT NULL DEFAULT '',
  page_count INTEGER NOT NULL DEFAULT 1 CHECK (page_count >= 1 AND page_count <= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_ocr_results_job UNIQUE(job_id)
);
CREATE INDEX IF NOT EXISTS idx_ocr_results_document ON crm_ocr_results(tenant_id, document_id, created_at);

ALTER TABLE crm_documents ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT '';
ALTER TABLE crm_documents ADD COLUMN IF NOT EXISTS tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE crm_documents ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE crm_documents ADD COLUMN IF NOT EXISTS owner_id TEXT REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE crm_documents ADD COLUMN IF NOT EXISTS current_version INTEGER NOT NULL DEFAULT 1;

UPDATE crm_documents SET owner_id = uploaded_by WHERE owner_id IS NULL;
ALTER TABLE crm_documents ALTER COLUMN owner_id SET NOT NULL;

CREATE TABLE IF NOT EXISTS crm_document_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES crm_documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  original_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  added_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (document_id, version),
  UNIQUE (storage_key)
);
CREATE INDEX IF NOT EXISTS idx_document_versions_lookup ON crm_document_versions(tenant_id, document_id, version DESC);

INSERT INTO crm_document_versions(id, tenant_id, document_id, version, storage_key, original_name, normalized_name, mime_type, size_bytes, sha256, added_by, created_at)
SELECT 'initial:' || id, tenant_id, id, 1, storage_key, original_name, normalized_name, mime_type, size_bytes, sha256, uploaded_by, created_at
FROM crm_documents
ON CONFLICT (document_id, version) DO NOTHING;

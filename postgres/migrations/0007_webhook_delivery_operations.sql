-- Métadonnées d'exploitation webhook v0.3.
-- Migration additive : aucune donnée historique n'est supprimée ni réécrite.

ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS correlation_id TEXT NOT NULL DEFAULT '';

ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS job_id TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_correlation
  ON webhook_deliveries(tenant_id, correlation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_job
  ON webhook_deliveries(tenant_id, job_id, created_at);

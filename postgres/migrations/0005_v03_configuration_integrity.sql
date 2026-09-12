-- Fermeture v0.3 : invariants tenant PostgreSQL pour le moteur configurable.
-- La validation des contraintes échoue explicitement si des données historiques
-- incohérentes existent ; aucune ligne n'est corrigée ou supprimée silencieusement.

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_config_tenant_id
  ON crm_configurations(tenant_id, id);

ALTER TABLE crm_configurations
  ADD COLUMN config_key TEXT
  GENERATED ALWAYS AS ((definition::jsonb ->> 'key')) STORED;

ALTER TABLE crm_configurations
  ALTER COLUMN config_key SET NOT NULL;

ALTER TABLE crm_configurations
  ADD CONSTRAINT chk_crm_config_key
  CHECK (config_key ~ '^[a-z][a-z0-9_-]{0,49}$');

CREATE UNIQUE INDEX idx_crm_config_tenant_kind_key
  ON crm_configurations(tenant_id, kind, config_key);

ALTER TABLE crm_records
  ADD CONSTRAINT fk_crm_records_tenant_team
  FOREIGN KEY (tenant_id, team_id)
  REFERENCES teams(tenant_id, id)
  ON DELETE RESTRICT;

ALTER TABLE crm_relations
  ADD CONSTRAINT fk_crm_relations_tenant_from
  FOREIGN KEY (tenant_id, from_record_id)
  REFERENCES crm_records(tenant_id, id)
  ON DELETE CASCADE;

ALTER TABLE crm_relations
  ADD CONSTRAINT fk_crm_relations_tenant_to
  FOREIGN KEY (tenant_id, to_record_id)
  REFERENCES crm_records(tenant_id, id)
  ON DELETE CASCADE;

ALTER TABLE crm_timeline_events
  ADD CONSTRAINT fk_crm_timeline_tenant_record
  FOREIGN KEY (tenant_id, record_id)
  REFERENCES crm_records(tenant_id, id)
  ON DELETE CASCADE;

ALTER TABLE crm_timeline_events
  ADD CONSTRAINT fk_crm_timeline_tenant_team
  FOREIGN KEY (tenant_id, team_id)
  REFERENCES teams(tenant_id, id)
  ON DELETE RESTRICT;

ALTER TABLE crm_configuration_versions
  ADD CONSTRAINT fk_crm_config_versions_tenant_config
  FOREIGN KEY (tenant_id, configuration_id)
  REFERENCES crm_configurations(tenant_id, id)
  ON DELETE CASCADE;

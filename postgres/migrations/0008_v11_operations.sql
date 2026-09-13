-- Clarity CRM v1.1 — extensions opérationnelles strictement additives.
-- Les objets métier restent dans crm_records. Ces tables ne portent que les
-- invariants qui nécessitent verrouillage transactionnel ou historique immuable.

ALTER TABLE crm_documents
  ADD COLUMN IF NOT EXISTS portal_visible INTEGER NOT NULL DEFAULT 0;

ALTER TABLE crm_documents
  ADD CONSTRAINT chk_crm_documents_portal_visible
  CHECK (portal_visible IN (0, 1));

CREATE TABLE IF NOT EXISTS inventory_balances (
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  threshold INTEGER NOT NULL DEFAULT 0 CHECK (threshold >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, product_id, location_id),
  CONSTRAINT fk_inventory_balance_product
    FOREIGN KEY (tenant_id, product_id)
    REFERENCES crm_records(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_balance_location
    FOREIGN KEY (tenant_id, location_id)
    REFERENCES crm_records(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_inventory_balances_threshold
  ON inventory_balances(tenant_id, quantity, threshold);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  quantity_delta INTEGER NOT NULL CHECK (quantity_delta <> 0),
  quantity_after INTEGER NOT NULL CHECK (quantity_after >= 0),
  reason TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_inventory_movement_product
    FOREIGN KEY (tenant_id, product_id)
    REFERENCES crm_records(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_movement_location
    FOREIGN KEY (tenant_id, location_id)
    REFERENCES crm_records(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT uq_inventory_movement_idempotency UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_lookup
  ON inventory_movements(tenant_id, product_id, location_id, created_at DESC);

CREATE TABLE IF NOT EXISTS loyalty_ledger (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  points_delta INTEGER NOT NULL CHECK (points_delta <> 0),
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  reason TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_loyalty_ledger_account
    FOREIGN KEY (tenant_id, account_id)
    REFERENCES crm_records(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT uq_loyalty_ledger_idempotency UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_loyalty_ledger_lookup
  ON loyalty_ledger(tenant_id, account_id, created_at DESC);

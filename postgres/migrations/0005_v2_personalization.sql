CREATE TABLE IF NOT EXISTS saved_views (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  scope TEXT NOT NULL DEFAULT 'personal',
  object_type TEXT NOT NULL,
  name TEXT NOT NULL,
  definition TEXT NOT NULL DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (scope IN ('personal', 'team', 'tenant')),
  CHECK ((scope = 'team' AND team_id IS NOT NULL) OR (scope <> 'team' AND team_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_saved_views_access ON saved_views(tenant_id, object_type, scope, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_saved_views_owner ON saved_views(tenant_id, owner_id, status, updated_at);

CREATE TABLE IF NOT EXISTS user_preferences (
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  settings TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS favorites (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, user_id, resource_type, resource_id)
);
CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(tenant_id, user_id, created_at);

CREATE TABLE IF NOT EXISTS dashboards (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  scope TEXT NOT NULL DEFAULT 'personal',
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (scope IN ('personal', 'team', 'tenant')),
  CHECK ((scope = 'team' AND team_id IS NOT NULL) OR (scope <> 'team' AND team_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_dashboards_access ON dashboards(tenant_id, scope, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_dashboards_owner ON dashboards(tenant_id, owner_id, status, updated_at);

CREATE TABLE IF NOT EXISTS dashboard_widgets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  widget_type TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  configuration TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (dashboard_id, position)
);
CREATE INDEX IF NOT EXISTS idx_dashboard_widgets_dashboard ON dashboard_widgets(tenant_id, dashboard_id, position);

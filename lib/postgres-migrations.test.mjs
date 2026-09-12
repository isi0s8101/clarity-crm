import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sql = await readFile(new URL("../postgres/migrations/0001_posix_foundations.sql", import.meta.url), "utf8");
const closureSql = await readFile(new URL("../postgres/migrations/0004_closure_documents_notifications_imports.sql", import.meta.url), "utf8");
const personalizationSql = await readFile(new URL("../postgres/migrations/0005_v2_personalization.sql", import.meta.url), "utf8");
for (const table of [
  "organizations", "users", "teams", "memberships", "role_permissions",
  "auth_credentials", "auth_sessions", "auth_login_attempts",
  "crm_records", "crm_relations", "crm_timeline_events", "crm_configurations",
  "automation_runs", "webhook_deliveries", "audit_events",
]) {
  assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "i"), `missing ${table}`);
}
assert.match(sql, /REFERENCES organizations\(id\)/i);
assert.match(sql, /UNIQUE \(tenant_id, user_id\)/i);
assert.match(sql, /idx_crm_records_tenant_type/i);
assert.match(sql, /idx_auth_sessions_expires/i);
for (const table of ["crm_documents", "crm_notifications", "crm_import_jobs"]) {
  assert.match(closureSql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "i"), `missing ${table}`);
}
assert.match(closureSql, /storage_key TEXT NOT NULL/i);
assert.match(closureSql, /recipient_id TEXT NOT NULL REFERENCES users/i);
assert.match(closureSql, /correlation_id TEXT NOT NULL DEFAULT ''/i);

for (const table of ["saved_views", "user_preferences", "favorites", "dashboards", "dashboard_widgets"]) {
  assert.match(personalizationSql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "i"), `missing ${table}`);
}
assert.match(personalizationSql, /CHECK \(scope IN \('personal', 'team', 'tenant'\)\)/i);
assert.match(personalizationSql, /PRIMARY KEY \(tenant_id, user_id\)/i);
assert.match(personalizationSql, /idx_saved_views_access/i);
assert.match(personalizationSql, /idx_dashboards_access/i);

console.log("postgres migration integrity tests: ok");

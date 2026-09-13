import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sql = await readFile(new URL("../postgres/migrations/0001_posix_foundations.sql", import.meta.url), "utf8");
const closureSql = await readFile(new URL("../postgres/migrations/0004_closure_documents_notifications_imports.sql", import.meta.url), "utf8");
const configurationIntegritySql = await readFile(new URL("../postgres/migrations/0005_v03_configuration_integrity.sql", import.meta.url), "utf8");
const automationQueueSql = await readFile(new URL("../postgres/migrations/0006_automation_queue.sql", import.meta.url), "utf8");
const webhookOperationsSql = await readFile(new URL("../postgres/migrations/0007_webhook_delivery_operations.sql", import.meta.url), "utf8");
const v11OperationsSql = await readFile(new URL("../postgres/migrations/0008_v11_operations.sql", import.meta.url), "utf8");
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
assert.match(configurationIntegritySql, /GENERATED ALWAYS AS \(lower\(btrim\(definition::jsonb ->> 'key'\)\)\) STORED/i);
assert.match(configurationIntegritySql, /idx_crm_config_tenant_kind_key/i);
assert.match(configurationIntegritySql, /FOREIGN KEY \(tenant_id, from_record_id\)/i);
assert.match(configurationIntegritySql, /FOREIGN KEY \(tenant_id, to_record_id\)/i);
assert.match(configurationIntegritySql, /FOREIGN KEY \(tenant_id, configuration_id\)/i);
assert.match(automationQueueSql, /CREATE TABLE IF NOT EXISTS automation_jobs/i);
assert.match(automationQueueSql, /CREATE TABLE IF NOT EXISTS automation_action_receipts/i);
assert.match(webhookOperationsSql, /ADD COLUMN IF NOT EXISTS correlation_id TEXT NOT NULL DEFAULT ''/i);
assert.match(webhookOperationsSql, /ADD COLUMN IF NOT EXISTS job_id TEXT NOT NULL DEFAULT ''/i);
assert.match(webhookOperationsSql, /idx_webhook_deliveries_correlation/i);
assert.match(webhookOperationsSql, /idx_webhook_deliveries_job/i);
for (const constraint of ["invitations_role_check", "memberships_role_check", "role_permissions_role_check"]) {
  assert.match(v11OperationsSql, new RegExp(`DROP CONSTRAINT IF EXISTS ${constraint}`, "i"), `missing role constraint drop: ${constraint}`);
  assert.match(v11OperationsSql, new RegExp(`ADD CONSTRAINT ${constraint} CHECK \\(role IN \\('admin', 'user', 'client'\\)\\)`, "i"), `missing client role constraint: ${constraint}`);
}
assert.match(v11OperationsSql, /ADD COLUMN IF NOT EXISTS portal_visible INTEGER NOT NULL DEFAULT 0/i);
assert.match(v11OperationsSql, /CREATE TABLE IF NOT EXISTS inventory_balances/i);
assert.match(v11OperationsSql, /CREATE TABLE IF NOT EXISTS inventory_movements/i);
assert.match(v11OperationsSql, /FOR(EIGN)? KEY \(tenant_id, product_id\)/i);
assert.match(v11OperationsSql, /FOR(EIGN)? KEY \(tenant_id, location_id\)/i);
assert.match(v11OperationsSql, /UNIQUE \(tenant_id, idempotency_key\)/i);
assert.match(v11OperationsSql, /CREATE TABLE IF NOT EXISTS loyalty_ledger/i);
assert.match(v11OperationsSql, /balance_after INTEGER NOT NULL CHECK \(balance_after >= 0\)/i);

console.log("postgres migration integrity tests: ok");

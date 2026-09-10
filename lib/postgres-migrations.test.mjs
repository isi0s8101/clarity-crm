import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sql = await readFile(new URL("../postgres/migrations/0001_posix_foundations.sql", import.meta.url), "utf8");
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

console.log("postgres migration integrity tests: ok");

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const migrationDir = join(process.cwd(), "legacy", "d1", "drizzle");
const migrationFiles = readdirSync(migrationDir)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();

assert.ok(migrationFiles.length >= 8, "Les migrations D1 legacy 0000 à 0007 doivent être présentes.");

for (let index = 0; index < migrationFiles.length; index += 1) {
  const expectedPrefix = String(index).padStart(4, "0");
  assert.ok(
    migrationFiles[index].startsWith(`${expectedPrefix}_`),
    `Migration manquante ou ordre incohérent à l'index ${index}.`,
  );
}

const journal = JSON.parse(
  readFileSync(join(migrationDir, "meta", "_journal.json"), "utf8"),
);
const journalTags = journal.entries.map((entry) => entry.tag);

assert.deepEqual(
  journal.entries.map((entry) => entry.idx),
  journal.entries.map((_, index) => index),
  "Les index du journal Drizzle D1 legacy doivent être continus.",
);

for (const file of migrationFiles) {
  const tag = file.replace(/\.sql$/, "");
  assert.ok(journalTags.includes(tag), `Migration ${tag} absente du journal Drizzle D1 legacy.`);
}

const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys = ON;");

for (const file of migrationFiles) {
  const rawSql = readFileSync(join(migrationDir, file), "utf8");
  const sql = rawSql.replaceAll("--> statement-breakpoint", "");
  db.exec(sql);
}

const tables = new Set(
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
);

for (const table of [
  "organizations",
  "users",
  "teams",
  "memberships",
  "role_permissions",
  "invitations",
  "opportunities",
  "audit_events",
  "crm_records",
  "crm_relations",
  "crm_timeline_events",
  "crm_configurations",
  "crm_configuration_versions",
  "automation_runs",
  "webhook_deliveries",
]) {
  assert.ok(tables.has(table), `Table attendue absente après migrations : ${table}`);
}

const auditColumns = new Set(
  db.prepare("PRAGMA table_info('audit_events')").all().map((row) => row.name),
);
assert.ok(auditColumns.has("team_id"), "audit_events.team_id doit exister pour le scope équipe.");

const indexes = new Set(
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name),
);
for (const index of [
  "idx_memberships_tenant_user",
  "idx_opportunities_tenant_owner",
  "idx_crm_records_tenant_type",
  "idx_crm_records_tenant_team_type",
  "idx_crm_relations_unique",
  "idx_crm_timeline_record",
  "idx_crm_config_tenant_kind",
  "idx_crm_config_versions_unique",
  "idx_webhook_deliveries_lookup",
  "idx_audit_events_tenant_team",
  "idx_audit_events_tenant_actor",
]) {
  assert.ok(indexes.has(index), `Index attendu absent après migrations : ${index}`);
}

const triggers = new Set(
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((row) => row.name),
);
for (const trigger of [
  "trg_crm_relations_tenant_insert",
  "trg_crm_relations_tenant_update",
  "trg_crm_timeline_tenant_insert",
]) {
  assert.ok(triggers.has(trigger), `Trigger attendu absent après migrations : ${trigger}`);
}

// Invariant DB : même en contournant l'API, une relation/timeline cross-tenant est refusée.
db.exec("INSERT INTO crm_records (id, tenant_id, team_id, owner_id, type, title) VALUES ('r-a', 'tenant-a', 'team-a', 'u-a', 'company', 'A');");
db.exec("INSERT INTO crm_records (id, tenant_id, team_id, owner_id, type, title) VALUES ('r-b', 'tenant-b', 'team-b', 'u-b', 'company', 'B');");
assert.throws(
  () => db.exec("INSERT INTO crm_relations (id, tenant_id, from_record_id, to_record_id, relation_type, created_by) VALUES ('rel-x', 'tenant-a', 'r-a', 'r-b', 'related', 'u-a');"),
  /crm_relation_cross_tenant/,
);
assert.throws(
  () => db.exec("INSERT INTO crm_timeline_events (tenant_id, team_id, owner_id, record_id, event_type, summary, actor_id) VALUES ('tenant-b', 'team-b', 'u-b', 'r-a', 'manual.note', 'x', 'u-b');"),
  /crm_timeline_cross_tenant/,
);

const fkViolationCount = db.prepare("PRAGMA foreign_key_check").all().length;
assert.equal(fkViolationCount, 0, "Les migrations ne doivent créer aucune violation de clé étrangère.");

db.close();
console.log("legacy D1 migration integrity tests: ok");

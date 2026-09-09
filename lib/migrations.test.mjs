import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const migrationDir = join(process.cwd(), "drizzle");
const migrationFiles = readdirSync(migrationDir)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();

assert.ok(migrationFiles.length >= 7, "Les migrations 0000 à 0006 doivent être présentes.");

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
  "Les index du journal Drizzle doivent être continus.",
);

for (const file of migrationFiles) {
  const tag = file.replace(/\.sql$/, "");
  assert.ok(journalTags.includes(tag), `Migration ${tag} absente du journal Drizzle.`);
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
  "crm_configurations",
  "automation_runs",
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
  "idx_crm_config_tenant_kind",
  "idx_audit_events_tenant_team",
  "idx_audit_events_tenant_actor",
]) {
  assert.ok(indexes.has(index), `Index attendu absent après migrations : ${index}`);
}

const fkViolationCount = db.prepare("PRAGMA foreign_key_check").all().length;
assert.equal(fkViolationCount, 0, "Les migrations ne doivent créer aucune violation de clé étrangère.");

db.close();
console.log("migration integrity tests: ok");

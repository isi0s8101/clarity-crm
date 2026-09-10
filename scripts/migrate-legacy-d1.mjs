#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "pg";

const TABLES = [
  { name: "organizations", columns: ["id", "name", "created_at"] },
  { name: "users", columns: ["id", "email", "display_name", "created_at", "updated_at"] },
  { name: "teams", columns: ["id", "tenant_id", "name", "created_at"] },
  { name: "memberships", columns: ["id", "tenant_id", "user_id", "team_id", "role", "status", "created_at", "updated_at"] },
  { name: "role_permissions", columns: ["id", "tenant_id", "role", "object", "action", "scope", "created_at"] },
  { name: "invitations", columns: ["id", "tenant_id", "email", "role", "team_id", "status", "invited_by", "created_at", "updated_at"] },
  { name: "opportunities", columns: ["id", "tenant_id", "team_id", "name", "company", "amount", "stage", "owner_id", "owner_email", "created_at", "updated_at"], serial: true },
  { name: "crm_records", columns: ["id", "tenant_id", "team_id", "owner_id", "type", "title", "data", "status", "created_at", "updated_at"] },
  { name: "crm_relations", columns: ["id", "tenant_id", "from_record_id", "to_record_id", "relation_type", "created_by", "created_at"] },
  { name: "crm_timeline_events", columns: ["id", "tenant_id", "team_id", "owner_id", "record_id", "event_type", "summary", "data", "actor_id", "created_at"], serial: true },
  { name: "crm_configurations", columns: ["id", "tenant_id", "kind", "name", "version", "active", "definition", "created_at", "updated_at"] },
  { name: "crm_configuration_versions", columns: ["id", "tenant_id", "configuration_id", "version", "name", "active", "definition", "created_by", "created_at"] },
  { name: "automation_runs", columns: ["id", "tenant_id", "automation_id", "status", "input", "output", "error", "created_at"] },
  { name: "webhook_deliveries", columns: ["id", "tenant_id", "webhook_id", "direction", "event", "status", "request_body", "response_code", "response_body", "error", "created_at"] },
  { name: "audit_events", columns: ["id", "tenant_id", "team_id", "actor_id", "actor_email", "action", "resource_type", "resource_id", "result", "before", "after", "entity_type", "entity_id", "details", "created_at"], serial: true },
];

const TABLE_NAMES = new Set(TABLES.map((table) => table.name));
const EXTENSIONS = new Set([".sqlite", ".sqlite3", ".db"]);
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const sourceArg = valueAfter("--source");
const sourceRoot = path.resolve(valueAfter("--source-root") ?? ".wrangler/state");

function valueAfter(flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} exige une valeur.`);
  return value;
}

function quoteSqliteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function walk(root) {
  const result = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return result;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await walk(full));
    else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name).toLowerCase())) result.push(full);
  }
  return result;
}

function sqliteTables(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name)));
}

function countSourceTable(db, name) {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${quoteSqliteIdentifier(name)}`).get().count);
}

function inspectDatabase(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = sqliteTables(db);
    const recognized = TABLES.filter((table) => tables.has(table.name));
    const counts = Object.fromEntries(recognized.map((table) => [table.name, countSourceTable(db, table.name)]));
    const rows = Object.values(counts).reduce((sum, count) => sum + count, 0);
    return {
      file,
      core: tables.has("organizations") && tables.has("users"),
      recognized: recognized.length,
      counts,
      rows,
    };
  } finally {
    db.close();
  }
}

function selectSource(inspections) {
  if (sourceArg) {
    const exact = inspections.find((item) => path.resolve(item.file) === path.resolve(sourceArg));
    if (!exact) throw new Error(`Base --source introuvable ou extension non reconnue: ${sourceArg}`);
    if (!exact.core) throw new Error("La base --source ne contient pas organizations + users.");
    return exact;
  }
  const candidates = inspections.filter((item) => item.core && item.recognized >= 3 && item.rows > 0);
  if (candidates.length === 0) throw new Error("Aucune base D1 Clarity CRM contenant des données n'a été identifiée.");
  if (candidates.length > 1) {
    throw new Error(`Plusieurs bases D1 Clarity CRM contiennent des données; préciser --source: ${candidates.map((item) => item.file).join(", ")}`);
  }
  return candidates[0];
}

function scalar(db, sql) {
  return Number(db.prepare(sql).get().count);
}

function assertZero(db, label, sql) {
  const count = scalar(db, sql);
  if (count !== 0) throw new Error(`${label}: ${count} anomalie(s). Migration refusée.`);
}

function validateSource(db) {
  assertZero(db, "emails utilisateurs dupliqués sans tenir compte de la casse", "SELECT COUNT(*) AS count FROM (SELECT lower(email) FROM users GROUP BY lower(email) HAVING COUNT(*) > 1)");
  assertZero(db, "teams sans tenant", "SELECT COUNT(*) AS count FROM teams t LEFT JOIN organizations o ON o.id=t.tenant_id WHERE o.id IS NULL");
  assertZero(db, "memberships sans tenant/user", "SELECT COUNT(*) AS count FROM memberships m LEFT JOIN organizations o ON o.id=m.tenant_id LEFT JOIN users u ON u.id=m.user_id WHERE o.id IS NULL OR u.id IS NULL");
  assertZero(db, "memberships avec team invalide", "SELECT COUNT(*) AS count FROM memberships m LEFT JOIN teams t ON t.id=m.team_id AND t.tenant_id=m.tenant_id WHERE m.team_id IS NOT NULL AND t.id IS NULL");
  assertZero(db, "memberships hors politique", "SELECT COUNT(*) AS count FROM memberships WHERE role NOT IN ('admin','user') OR status NOT IN ('active','disabled')");
  assertZero(db, "permissions hors politique", "SELECT COUNT(*) AS count FROM role_permissions WHERE role NOT IN ('admin','user') OR scope NOT IN ('personal','team','tenant')");
  assertZero(db, "invitations orphelines", "SELECT COUNT(*) AS count FROM invitations i LEFT JOIN organizations o ON o.id=i.tenant_id LEFT JOIN users u ON u.id=i.invited_by LEFT JOIN teams t ON t.id=i.team_id AND t.tenant_id=i.tenant_id WHERE o.id IS NULL OR u.id IS NULL OR (i.team_id IS NOT NULL AND t.id IS NULL)");
  assertZero(db, "opportunités orphelines", "SELECT COUNT(*) AS count FROM opportunities x LEFT JOIN organizations o ON o.id=x.tenant_id LEFT JOIN teams t ON t.id=x.team_id AND t.tenant_id=x.tenant_id LEFT JOIN users u ON u.id=x.owner_id WHERE o.id IS NULL OR t.id IS NULL OR u.id IS NULL");
  assertZero(db, "records CRM orphelins", "SELECT COUNT(*) AS count FROM crm_records x LEFT JOIN organizations o ON o.id=x.tenant_id LEFT JOIN teams t ON t.id=x.team_id AND t.tenant_id=x.tenant_id LEFT JOIN users u ON u.id=x.owner_id WHERE o.id IS NULL OR t.id IS NULL OR u.id IS NULL");
  assertZero(db, "relations CRM orphelines", "SELECT COUNT(*) AS count FROM crm_relations x LEFT JOIN organizations o ON o.id=x.tenant_id LEFT JOIN crm_records f ON f.id=x.from_record_id AND f.tenant_id=x.tenant_id LEFT JOIN crm_records t ON t.id=x.to_record_id AND t.tenant_id=x.tenant_id LEFT JOIN users u ON u.id=x.created_by WHERE o.id IS NULL OR f.id IS NULL OR t.id IS NULL OR u.id IS NULL");
  assertZero(db, "timeline CRM orpheline", "SELECT COUNT(*) AS count FROM crm_timeline_events x LEFT JOIN organizations o ON o.id=x.tenant_id LEFT JOIN teams t ON t.id=x.team_id AND t.tenant_id=x.tenant_id LEFT JOIN users uo ON uo.id=x.owner_id LEFT JOIN users ua ON ua.id=x.actor_id LEFT JOIN crm_records r ON r.id=x.record_id AND r.tenant_id=x.tenant_id WHERE o.id IS NULL OR t.id IS NULL OR uo.id IS NULL OR ua.id IS NULL OR r.id IS NULL");
  assertZero(db, "configurations CRM sans tenant", "SELECT COUNT(*) AS count FROM crm_configurations x LEFT JOIN organizations o ON o.id=x.tenant_id WHERE o.id IS NULL");
  assertZero(db, "versions de configuration orphelines", "SELECT COUNT(*) AS count FROM crm_configuration_versions x LEFT JOIN organizations o ON o.id=x.tenant_id LEFT JOIN crm_configurations c ON c.id=x.configuration_id AND c.tenant_id=x.tenant_id LEFT JOIN users u ON u.id=x.created_by WHERE o.id IS NULL OR c.id IS NULL OR u.id IS NULL");
  assertZero(db, "automations sans tenant", "SELECT COUNT(*) AS count FROM automation_runs x LEFT JOIN organizations o ON o.id=x.tenant_id WHERE o.id IS NULL");
  assertZero(db, "webhooks sans tenant", "SELECT COUNT(*) AS count FROM webhook_deliveries x LEFT JOIN organizations o ON o.id=x.tenant_id WHERE o.id IS NULL");
  assertZero(db, "audit sans tenant", "SELECT COUNT(*) AS count FROM audit_events x LEFT JOIN organizations o ON o.id=x.tenant_id WHERE o.id IS NULL");
  assertZero(db, "audit avec team invalide", "SELECT COUNT(*) AS count FROM audit_events x LEFT JOIN teams t ON t.id=x.team_id AND t.tenant_id=x.tenant_id WHERE x.team_id IS NOT NULL AND t.id IS NULL");
}

async function sourceSha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function postgresClient() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (connectionString && !/^postgres(?:ql)?:\/\//i.test(connectionString)) throw new Error("DATABASE_URL PostgreSQL invalide.");
  const client = new Client(connectionString ? { connectionString } : undefined);
  await client.connect();
  return client;
}

async function assertTargetEmpty(client) {
  for (const table of TABLES) {
    const exists = await client.query("SELECT to_regclass($1) AS name", [`public.${table.name}`]);
    if (!exists.rows[0]?.name) throw new Error(`Table PostgreSQL absente: ${table.name}. Exécuter d'abord db:migrate.`);
    const result = await client.query(`SELECT COUNT(*)::int AS count FROM ${table.name}`);
    if (Number(result.rows[0]?.count ?? 0) !== 0) throw new Error(`PostgreSQL non vide: ${table.name} contient ${result.rows[0].count} ligne(s).`);
  }
}

function sourceRows(db, table) {
  const columns = table.columns.map(quoteSqliteIdentifier).join(", ");
  return db.prepare(`SELECT ${columns} FROM ${quoteSqliteIdentifier(table.name)}`).all();
}

async function insertTable(client, db, table) {
  const rows = sourceRows(db, table);
  if (rows.length === 0) return 0;
  const columnSql = table.columns.join(", ");
  const placeholders = table.columns.map((_, index) => `$${index + 1}`).join(", ");
  const sql = `INSERT INTO ${table.name} (${columnSql}) VALUES (${placeholders})`;
  for (const row of rows) {
    await client.query(sql, table.columns.map((column) => row[column] ?? null));
  }
  return rows.length;
}

async function resetSequence(client, table) {
  const seq = await client.query("SELECT pg_get_serial_sequence($1, 'id') AS seq", [table.name]);
  if (!seq.rows[0]?.seq) return;
  await client.query(`SELECT setval($1::regclass, COALESCE((SELECT MAX(id) FROM ${table.name}), 1), EXISTS(SELECT 1 FROM ${table.name}))`, [seq.rows[0].seq]);
}

const files = sourceArg ? [path.resolve(sourceArg)] : await walk(sourceRoot);
if (files.length === 0) throw new Error(`Aucune base SQLite trouvée sous ${sourceRoot}.`);
const inspections = files.map(inspectDatabase);
console.log("=== D1 détectées ===");
for (const item of inspections) console.log(`${item.file} core=${item.core ? "yes" : "no"} recognized=${item.recognized} rows=${item.rows}`);
const selected = selectSource(inspections);
console.log(`SOURCE=${selected.file}`);
console.log(`SOURCE_RECOGNIZED_ROWS=${selected.rows}`);
for (const table of TABLES) console.log(`${table.name}=${selected.counts[table.name] ?? 0}`);

const db = new DatabaseSync(selected.file, { readOnly: true });
try {
  validateSource(db);
  console.log("SOURCE_INVARIANTS=OK");
  if (!apply) {
    console.log("LEGACY_D1_DRY_RUN=OK");
    process.exitCode = 0;
  } else {
    const client = await postgresClient();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext($1))", ["clarity-crm:legacy-d1-import"]);
      await assertTargetEmpty(client);
      const sha256 = await sourceSha256(selected.file);
      const metadata = await stat(selected.file);
      await client.query("BEGIN");
      try {
        let imported = 0;
        for (const table of TABLES) imported += await insertTable(client, db, table);
        for (const table of TABLES.filter((item) => item.serial)) await resetSequence(client, table);
        await client.query(
          `INSERT INTO _clarity_legacy_imports(source_sha256, source_path, source_size, imported_rows)
           VALUES ($1, $2, $3, $4)`,
          [sha256, selected.file, metadata.size, imported],
        );
        await client.query("COMMIT");
        if (imported !== selected.rows) throw new Error(`Compteur importé inattendu: source=${selected.rows}, import=${imported}`);
        for (const table of TABLES) {
          const target = await client.query(`SELECT COUNT(*)::int AS count FROM ${table.name}`);
          const expected = selected.counts[table.name] ?? 0;
          if (Number(target.rows[0]?.count ?? 0) !== expected) throw new Error(`Vérification ${table.name}: attendu=${expected}, obtenu=${target.rows[0]?.count}`);
        }
        console.log(`IMPORTED_ROWS=${imported}`);
        console.log(`SOURCE_SHA256=${sha256}`);
        console.log("LEGACY_D1_MIGRATION=OK");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", ["clarity-crm:legacy-d1-import"]).catch(() => undefined);
      await client.end();
    }
  }
} finally {
  db.close();
}

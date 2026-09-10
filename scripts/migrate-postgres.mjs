#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(root, "postgres", "migrations");
const connectionString = process.env.DATABASE_URL?.trim();
if (connectionString && !/^postgres(?:ql)?:\/\//i.test(connectionString)) {
  throw new Error("DATABASE_URL doit utiliser postgresql:// ou postgres://");
}

const client = new Client(connectionString ? { connectionString } : undefined);
await client.connect();
try {
  await client.query("SELECT pg_advisory_lock(hashtext($1))", ["clarity-crm:migrations"]);
  await client.query(`
    CREATE TABLE IF NOT EXISTS _clarity_migrations (
      name TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter((name) => /^\d+_[A-Za-z0-9._-]+\.sql$/.test(name))
    .sort();
  if (files.length === 0) throw new Error("Aucune migration PostgreSQL trouvée.");

  for (const name of files) {
    const sql = await readFile(path.join(migrationsDir, name), "utf8");
    const sha256 = createHash("sha256").update(sql).digest("hex");
    const existing = await client.query(
      "SELECT sha256 FROM _clarity_migrations WHERE name = $1",
      [name],
    );
    if (existing.rowCount) {
      if (existing.rows[0].sha256 !== sha256) {
        throw new Error(`Checksum de migration modifié après application: ${name}`);
      }
      console.log(`[SKIP] ${name}`);
      continue;
    }

    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(
        "INSERT INTO _clarity_migrations(name, sha256) VALUES ($1, $2)",
        [name, sha256],
      );
      await client.query("COMMIT");
      console.log(`[OK] ${name}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await client.query("SELECT pg_advisory_unlock(hashtext($1))", ["clarity-crm:migrations"]).catch(() => undefined);
  await client.end();
}

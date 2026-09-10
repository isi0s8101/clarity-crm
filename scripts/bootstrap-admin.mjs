#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

import { hashPassword, normalizeEmail, validatePassword } from "../lib/auth-crypto.js";

const email = normalizeEmail(process.env.CLARITY_ADMIN_EMAIL ?? "admin@clarity.local");
if (!email) throw new Error("CLARITY_ADMIN_EMAIL invalide.");

const passwordFile = process.env.CLARITY_ADMIN_PASSWORD_FILE?.trim();
const password = passwordFile
  ? (await readFile(passwordFile, "utf8")).replace(/[\r\n]+$/, "")
  : process.env.CLARITY_ADMIN_PASSWORD ?? "";
const passwordValidation = validatePassword(password);
if (!passwordValidation.ok) throw new Error(passwordValidation.error);

const displayName = (process.env.CLARITY_ADMIN_NAME ?? "Administrateur Clarity").trim().slice(0, 160);
const tenantId = (process.env.CLARITY_BOOTSTRAP_TENANT_ID ?? "default").trim();
const tenantName = (process.env.CLARITY_BOOTSTRAP_TENANT_NAME ?? "Clarity CRM").trim().slice(0, 160);
const teamId = (process.env.CLARITY_BOOTSTRAP_TEAM_ID ?? "default-sales").trim();
const teamName = (process.env.CLARITY_BOOTSTRAP_TEAM_NAME ?? "Équipe commerciale").trim().slice(0, 160);
for (const [label, value] of [["tenant", tenantId], ["team", teamId]]) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value)) throw new Error(`${label} id invalide.`);
}

const connectionString = process.env.DATABASE_URL?.trim();
const client = new Client(connectionString ? { connectionString } : undefined);
await client.connect();
try {
  await client.query("SELECT pg_advisory_lock(hashtext($1))", ["clarity-crm:bootstrap"]);
  const credentialCount = await client.query("SELECT count(*)::int AS count FROM auth_credentials");
  if (Number(credentialCount.rows[0]?.count ?? 0) !== 0) {
    console.log("[SKIP] Bootstrap déjà effectué : des identifiants natifs existent.");
    process.exitCode = 0;
  } else {
    const passwordHash = await hashPassword(password);
    await client.query("BEGIN");
    try {
      await client.query(
        "INSERT INTO organizations(id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
        [tenantId, tenantName],
      );
      await client.query(
        "INSERT INTO teams(id, tenant_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
        [teamId, tenantId, teamName],
      );

      const existing = await client.query("SELECT id FROM users WHERE email = $1 LIMIT 1", [email]);
      const userId = existing.rows[0]?.id ?? randomUUID();
      if (!existing.rowCount) {
        await client.query(
          "INSERT INTO users(id, email, display_name) VALUES ($1, $2, $3)",
          [userId, email, displayName || email],
        );
      } else {
        await client.query(
          "UPDATE users SET display_name = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
          [userId, displayName || email],
        );
      }
      await client.query(
        "INSERT INTO auth_credentials(user_id, password_hash) VALUES ($1, $2)",
        [userId, passwordHash],
      );
      await client.query(
        `INSERT INTO memberships(id, tenant_id, user_id, team_id, role, status)
         VALUES ($1, $2, $3, $4, 'admin', 'active')
         ON CONFLICT (tenant_id, user_id)
         DO UPDATE SET team_id = EXCLUDED.team_id, role = 'admin', status = 'active', updated_at = CURRENT_TIMESTAMP`,
        [`${tenantId}:${userId}`, tenantId, userId, teamId],
      );
      await client.query("COMMIT");
      console.log(`[OK] Administrateur natif créé: ${email}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await client.query("SELECT pg_advisory_unlock(hashtext($1))", ["clarity-crm:bootstrap"]).catch(() => undefined);
  await client.end();
}

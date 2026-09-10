import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

declare global {
  var __clarityPostgresPool: Pool | undefined;
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function createPool() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (connectionString && !/^postgres(?:ql)?:\/\//i.test(connectionString)) {
    throw new Error("DATABASE_URL doit utiliser le schéma postgresql:// ou postgres://.");
  }

  return new Pool({
    ...(connectionString ? { connectionString } : {}),
    max: positiveInteger(process.env.CLARITY_DB_POOL_MAX, 10, 50),
    idleTimeoutMillis: positiveInteger(process.env.CLARITY_DB_IDLE_TIMEOUT_MS, 30_000, 300_000),
    connectionTimeoutMillis: positiveInteger(process.env.CLARITY_DB_CONNECT_TIMEOUT_MS, 5_000, 60_000),
    application_name: "clarity-crm",
  });
}

export function getPool() {
  if (!globalThis.__clarityPostgresPool) {
    globalThis.__clarityPostgresPool = createPool();
  }
  return globalThis.__clarityPostgresPool;
}

export function getDb() {
  return drizzle(getPool(), { schema });
}

export async function checkDatabase() {
  const result = await getPool().query<{ ok: number }>("SELECT 1 AS ok");
  return result.rows[0]?.ok === 1;
}

import { defineConfig } from "drizzle-kit";

// Configuration de génération PostgreSQL uniquement.
// Les migrations runtime applicables en production sont les fichiers SQL
// versionnés dans postgres/migrations. L'historique D1 a été déplacé sous
// legacy/d1/drizzle pour éviter toute ambiguïté runtime.
export default defineConfig({
  out: "./postgres/generated",
  schema: "./db/schema.ts",
  dialect: "postgresql",
  dbCredentials: process.env.DATABASE_URL ? { url: process.env.DATABASE_URL } : undefined,
});

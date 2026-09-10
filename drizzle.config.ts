import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./postgres/generated",
  schema: "./db/schema.ts",
  dialect: "postgresql",
  dbCredentials: process.env.DATABASE_URL ? { url: process.env.DATABASE_URL } : undefined,
});

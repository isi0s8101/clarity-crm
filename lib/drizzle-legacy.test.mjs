import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const runtimeJournal = join(process.cwd(), "drizzle", "meta", "_journal.json");
if (existsSync(runtimeJournal)) {
  const runtimeDir = join(process.cwd(), "drizzle");
  const runtime = JSON.parse(readFileSync(runtimeJournal, "utf8"));
  for (const entry of runtime.entries ?? []) {
    const migration = join(runtimeDir, `${entry.tag}.sql`);
    const snapshot = join(runtimeDir, "meta", `${String(entry.idx).padStart(4, "0")}_snapshot.json`);
    assert.ok(existsSync(migration), `Migration Drizzle runtime absente: ${entry.tag}`);
    assert.ok(existsSync(snapshot), `Snapshot Drizzle runtime absent pour ${entry.tag}`);
  }
}

const legacyDir = join(process.cwd(), "legacy", "d1", "drizzle");
const journalPath = join(legacyDir, "meta", "_journal.json");
assert.ok(existsSync(journalPath), "Le journal Drizzle D1 legacy doit être conservé sous legacy/d1/drizzle.");

const journal = JSON.parse(readFileSync(journalPath, "utf8"));
assert.equal(journal.dialect, "sqlite", "Le journal legacy doit rester marqué sqlite/D1.");

const migrationTags = readdirSync(legacyDir)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort()
  .map((name) => name.replace(/\.sql$/, ""));
const journalTags = (journal.entries ?? []).map((entry) => entry.tag);

assert.deepEqual(migrationTags, journalTags, "Chaque migration D1 legacy doit correspondre exactement au journal.");

const snapshotTags = readdirSync(join(legacyDir, "meta"))
  .filter((name) => /^\d{4}_snapshot\.json$/.test(name))
  .sort()
  .map((name) => {
    const idx = Number(name.slice(0, 4));
    return journal.entries.find((entry) => entry.idx === idx)?.tag;
  })
  .filter(Boolean);

for (const tag of snapshotTags) {
  assert.ok(journalTags.includes(tag), `Snapshot legacy orphelin: ${tag}`);
}

console.log("drizzle legacy classification tests: ok");

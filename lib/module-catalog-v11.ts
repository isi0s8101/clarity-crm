import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { crmConfigurations, crmConfigurationVersions, crmRecords, crmRelations } from "@/db/schema";
import { audit, type AuthContext } from "@/lib/authz";
import { validateConfiguration } from "@/lib/crm-policy.js";
import { BUILTIN_TEMPLATES, getBuiltinTemplate, type BuiltinTemplate, type TemplateConfig } from "@/lib/crm-templates";

export class ModuleCatalogError extends Error { constructor(message: string, public status = 400) { super(message); } }
type StateEntry = TemplateConfig & { managed: boolean; previousActive: boolean };
type Marker = { key: string; templateKey: string; configs: StateEntry[] };

export async function listModuleCatalog(actor: AuthContext) {
  const rows = await getDb().select().from(crmConfigurations).where(and(eq(crmConfigurations.tenantId, actor.tenantId), eq(crmConfigurations.kind, "template"))).limit(100);
  const installed = new Map<string, typeof crmConfigurations.$inferSelect>();
  for (const row of rows) { const marker = parseMarker(row.definition); if (marker) installed.set(marker.templateKey, row); }
  return BUILTIN_TEMPLATES.map((template) => ({ key: template.key, name: template.name, description: template.description, prerequisites: template.prerequisites ?? [], impacts: template.impacts ?? [], installed: installed.has(template.key), active: installed.get(template.key)?.active === 1, version: installed.get(template.key)?.version ?? null }));
}

export async function installBuiltinTemplate(actor: AuthContext, templateKey: string) {
  const template = getBuiltinTemplate(templateKey); if (!template) throw new ModuleCatalogError("Template inconnu.", 404);
  await assertPrerequisites(actor.tenantId, template);
  const markerKey = `builtin_${template.key}`; const markerRow = await findConfig(actor.tenantId, "template", markerKey); const prior = markerRow ? parseMarker(markerRow.definition) : null;
  if (markerRow?.active === 1) { await assertInstallationConsistent(actor.tenantId, prior); return { template: template.key, idempotent: true, reactivated: false, items: [] }; }

  const prepared: Array<{ entry: TemplateConfig; existing: typeof crmConfigurations.$inferSelect | null; managed: boolean; previousActive: boolean }> = [];
  for (const raw of template.configs) {
    const validation = validateConfiguration(raw.kind, structuredClone(raw.definition)); if (!validation.ok) throw new ModuleCatalogError(`Template invalide (${raw.name}) : ${validation.error}`, 500);
    const entry = { ...raw, definition: validation.value }; const existing = await findConfig(actor.tenantId, entry.kind, String(entry.definition.key));
    if (existing && stable(existing.definition) !== stable(JSON.stringify(entry.definition))) throw new ModuleCatalogError(`Conflit avec la configuration existante « ${entry.name} ».`, 409);
    const previous = prior?.configs.find((item) => item.kind === entry.kind && item.definition.key === entry.definition.key);
    prepared.push({ entry, existing, managed: previous?.managed ?? !existing, previousActive: previous?.previousActive ?? (existing?.active === 1) });
  }

  const items = await getDb().transaction(async (tx) => {
    const states: StateEntry[] = []; const changed: Array<Record<string, unknown>> = [];
    for (const item of prepared) {
      if (item.existing) {
        if (item.existing.active !== 1) {
          const rows = await tx.update(crmConfigurations).set({ active: 1, version: item.existing.version + 1, updatedAt: new Date().toISOString() }).where(and(eq(crmConfigurations.tenantId, actor.tenantId), eq(crmConfigurations.id, item.existing.id), eq(crmConfigurations.version, item.existing.version))).returning();
          if (!rows[0]) throw new ModuleCatalogError("Conflit de réactivation de configuration.", 409); await tx.insert(crmConfigurationVersions).values(snapshot(actor, rows[0])); changed.push(decode(rows[0]));
        }
      } else {
        const rows = await tx.insert(crmConfigurations).values({ id: crypto.randomUUID(), tenantId: actor.tenantId, kind: item.entry.kind, name: item.entry.name, version: 1, active: 1, definition: JSON.stringify(item.entry.definition) }).returning();
        await tx.insert(crmConfigurationVersions).values(snapshot(actor, rows[0])); changed.push(decode(rows[0]));
      }
      states.push({ ...item.entry, managed: item.managed, previousActive: item.previousActive });
    }
    const marker: Marker = { key: markerKey, templateKey: template.key, configs: states }; const valid = validateConfiguration("template", marker); if (!valid.ok) throw new ModuleCatalogError(`Marqueur d'installation invalide : ${valid.error}`, 500);
    if (markerRow) {
      const rows = await tx.update(crmConfigurations).set({ name: `Installation ${template.name}`, active: 1, version: markerRow.version + 1, definition: JSON.stringify(valid.value), updatedAt: new Date().toISOString() }).where(and(eq(crmConfigurations.tenantId, actor.tenantId), eq(crmConfigurations.id, markerRow.id), eq(crmConfigurations.version, markerRow.version))).returning();
      if (!rows[0]) throw new ModuleCatalogError("Conflit de réactivation du template.", 409); await tx.insert(crmConfigurationVersions).values(snapshot(actor, rows[0]));
    } else {
      const rows = await tx.insert(crmConfigurations).values({ id: crypto.randomUUID(), tenantId: actor.tenantId, kind: "template", name: `Installation ${template.name}`, version: 1, active: 1, definition: JSON.stringify(valid.value) }).returning(); await tx.insert(crmConfigurationVersions).values(snapshot(actor, rows[0]));
    }
    return changed;
  });
  await audit(actor, { action: markerRow ? "template.reactivated" : "template.installed", resourceType: "template", resourceId: template.key, result: "success", details: { configurations: items.map((item) => item.id) } });
  return { template: template.key, idempotent: false, reactivated: Boolean(markerRow), items };
}

export async function rollbackBuiltinTemplate(actor: AuthContext, templateKey: string) {
  const template = getBuiltinTemplate(templateKey); if (!template) throw new ModuleCatalogError("Template inconnu.", 404);
  const markerRow = await findConfig(actor.tenantId, "template", `builtin_${template.key}`); if (!markerRow) throw new ModuleCatalogError("Template non installé.", 404); if (markerRow.active !== 1) return { template: template.key, idempotent: true, rolledBack: true };
  const marker = parseMarker(markerRow.definition); if (!marker || marker.templateKey !== template.key) throw new ModuleCatalogError("Marqueur d'installation incohérent.", 409);
  const deactivate: Array<typeof crmConfigurations.$inferSelect> = [];
  for (const state of marker.configs) {
    if (!state.managed && state.previousActive !== false) continue;
    const config = await findConfig(actor.tenantId, state.kind, String(state.definition.key)); if (!config) throw new ModuleCatalogError(`Configuration gérée absente : ${state.name}.`, 409);
    if (stable(config.definition) !== stable(JSON.stringify(state.definition))) throw new ModuleCatalogError(`Configuration modifiée depuis l'installation : ${state.name}.`, 409);
    await assertSafeDeactivation(actor.tenantId, config); deactivate.push(config);
  }
  await getDb().transaction(async (tx) => {
    for (const config of [...deactivate].reverse()) {
      if (config.active !== 1) continue; const rows = await tx.update(crmConfigurations).set({ active: 0, version: config.version + 1, updatedAt: new Date().toISOString() }).where(and(eq(crmConfigurations.tenantId, actor.tenantId), eq(crmConfigurations.id, config.id), eq(crmConfigurations.version, config.version))).returning();
      if (!rows[0]) throw new ModuleCatalogError("Conflit pendant le rollback.", 409); await tx.insert(crmConfigurationVersions).values(snapshot(actor, rows[0]));
    }
    const rows = await tx.update(crmConfigurations).set({ active: 0, version: markerRow.version + 1, updatedAt: new Date().toISOString() }).where(and(eq(crmConfigurations.tenantId, actor.tenantId), eq(crmConfigurations.id, markerRow.id), eq(crmConfigurations.version, markerRow.version))).returning();
    if (!rows[0]) throw new ModuleCatalogError("Conflit pendant le rollback du template.", 409); await tx.insert(crmConfigurationVersions).values(snapshot(actor, rows[0]));
  });
  await audit(actor, { action: "template.rolled_back", resourceType: "template", resourceId: template.key, result: "success", details: { deactivated: deactivate.map((item) => item.configKey) } });
  return { template: template.key, idempotent: false, rolledBack: true };
}

async function assertPrerequisites(tenantId: string, template: BuiltinTemplate) { for (const key of template.prerequisites ?? []) { const marker = await findConfig(tenantId, "template", `builtin_${key}`); if (!marker || marker.active !== 1) throw new ModuleCatalogError(`Prérequis non satisfait : template ${key}.`, 409); } }
async function assertInstallationConsistent(tenantId: string, marker: Marker | null) { if (!marker) throw new ModuleCatalogError("Marqueur d'installation incohérent.", 409); for (const state of marker.configs) { const row = await findConfig(tenantId, state.kind, String(state.definition.key)); if (!row || row.active !== 1 || stable(row.definition) !== stable(JSON.stringify(state.definition))) throw new ModuleCatalogError(`Installation incohérente : ${state.name}.`, 409); } }
async function assertSafeDeactivation(tenantId: string, config: typeof crmConfigurations.$inferSelect) {
  const key = config.configKey;
  if (config.kind === "object") { const row = await getDb().select({ id: crmRecords.id }).from(crmRecords).where(and(eq(crmRecords.tenantId, tenantId), eq(crmRecords.type, key))).limit(1); if (row[0]) throw new ModuleCatalogError(`Rollback refusé : l'objet ${key} contient des données.`, 409); }
  if (config.kind === "pipeline") { const rows = await getDb().select({ data: crmRecords.data }).from(crmRecords).where(eq(crmRecords.tenantId, tenantId)).limit(2000); if (rows.some((row) => { try { return (JSON.parse(row.data) as Record<string, unknown>).pipelineKey === key; } catch { return false; } })) throw new ModuleCatalogError(`Rollback refusé : le pipeline ${key} est utilisé.`, 409); }
  if (config.kind === "relation") { const row = await getDb().select({ id: crmRelations.id }).from(crmRelations).where(and(eq(crmRelations.tenantId, tenantId), eq(crmRelations.relationType, key))).limit(1); if (row[0]) throw new ModuleCatalogError(`Rollback refusé : la relation ${key} est utilisée.`, 409); }
  if (config.kind === "module") { const rows = await getDb().select().from(crmConfigurations).where(and(eq(crmConfigurations.tenantId, tenantId), eq(crmConfigurations.kind, "module"), eq(crmConfigurations.active, 1))).limit(200); for (const row of rows) { if (row.id === config.id) continue; try { const data = JSON.parse(row.definition) as { dependsOn?: unknown }; if (Array.isArray(data.dependsOn) && data.dependsOn.includes(key)) throw new ModuleCatalogError(`Rollback refusé : le module ${row.name} dépend de ${key}.`, 409); } catch (error) { if (error instanceof ModuleCatalogError) throw error; } } }
}
async function findConfig(tenantId: string, kind: string, key: string) { const rows = await getDb().select().from(crmConfigurations).where(and(eq(crmConfigurations.tenantId, tenantId), eq(crmConfigurations.kind, kind), eq(crmConfigurations.configKey, key))).limit(1); return rows[0] ?? null; }
function parseMarker(value: string): Marker | null { try { const data = JSON.parse(value) as Partial<Marker>; if (typeof data.key !== "string" || typeof data.templateKey !== "string" || !Array.isArray(data.configs)) return null; return { ...data, configs: data.configs.map((item) => ({ ...item, previousActive: item.previousActive ?? true })) } as Marker; } catch { return null; } }
function stable(value: string) { try { return JSON.stringify(sort(JSON.parse(value))); } catch { return value; } }
function sort(value: unknown): unknown { if (Array.isArray(value)) return value.map(sort); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sort(item)])); }
function snapshot(actor: AuthContext, config: typeof crmConfigurations.$inferSelect) { return { id: `${config.id}:${config.version}`, tenantId: actor.tenantId, configurationId: config.id, version: config.version, name: config.name, active: config.active, definition: config.definition, createdBy: actor.userId }; }
function decode(row: typeof crmConfigurations.$inferSelect) { return { ...row, active: row.active === 1, definition: JSON.parse(row.definition) as Record<string, unknown> }; }

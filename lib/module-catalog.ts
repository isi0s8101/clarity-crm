import { and, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { crmConfigurations, crmConfigurationVersions, crmRecords, crmRelations } from "@/db/schema";
import { audit, type AuthContext } from "@/lib/authz";
import { validateConfiguration } from "@/lib/crm-policy.js";
import { BUILTIN_TEMPLATES, getBuiltinTemplate, type BuiltinTemplate, type TemplateConfig } from "@/lib/crm-templates";

export class ModuleCatalogError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

type ManagedEntry = TemplateConfig & { managed: boolean };
type InstallationMarker = {
  key: string;
  templateKey: string;
  configs: ManagedEntry[];
};

export async function listModuleCatalog(actor: AuthContext) {
  const rows = await getDb()
    .select()
    .from(crmConfigurations)
    .where(and(eq(crmConfigurations.tenantId, actor.tenantId), eq(crmConfigurations.kind, "template")))
    .limit(100);
  const installations = new Map<string, { active: boolean; version: number; id: string }>();
  for (const row of rows) {
    const marker = parseMarker(row.definition);
    if (!marker) continue;
    installations.set(marker.templateKey, { active: row.active === 1, version: row.version, id: row.id });
  }
  return BUILTIN_TEMPLATES.map((template) => ({
    key: template.key,
    name: template.name,
    description: template.description,
    prerequisites: template.prerequisites ?? [],
    impacts: template.impacts ?? [],
    installed: installations.has(template.key),
    active: installations.get(template.key)?.active ?? false,
    version: installations.get(template.key)?.version ?? null,
  }));
}

export async function installBuiltinTemplate(actor: AuthContext, templateKey: string) {
  const template = getBuiltinTemplate(templateKey);
  if (!template) throw new ModuleCatalogError("Template inconnu.", 404);
  await assertPrerequisites(actor.tenantId, template);

  const db = getDb();
  const markerKey = markerConfigKey(template.key);
  const existingMarker = await findConfig(actor.tenantId, "template", markerKey);
  if (existingMarker?.active === 1) {
    return { template: template.key, idempotent: true, reactivated: false, items: [] };
  }

  const prepared: Array<{ entry: TemplateConfig; existing: typeof crmConfigurations.$inferSelect | null }> = [];
  for (const entry of template.configs) {
    const validation = validateConfiguration(entry.kind, structuredClone(entry.definition));
    if (!validation.ok) throw new ModuleCatalogError(`Template invalide (${entry.name}) : ${validation.error}`, 500);
    const existing = await findConfig(actor.tenantId, entry.kind, String(validation.value.key));
    if (existing) {
      const current = stableDefinition(existing.definition);
      const expected = stableDefinition(JSON.stringify(validation.value));
      if (current !== expected) {
        throw new ModuleCatalogError(`Conflit avec la configuration existante « ${entry.name} ».`, 409);
      }
    }
    prepared.push({ entry: { ...entry, definition: validation.value }, existing });
  }

  const installed = await db.transaction(async (tx) => {
    const managedEntries: ManagedEntry[] = [];
    const items: Array<Record<string, unknown>> = [];
    for (const preparedEntry of prepared) {
      if (preparedEntry.existing) {
        if (preparedEntry.existing.active !== 1) {
          const nextVersion = preparedEntry.existing.version + 1;
          const rows = await tx.update(crmConfigurations).set({
            active: 1,
            version: nextVersion,
            updatedAt: new Date().toISOString(),
          }).where(and(
            eq(crmConfigurations.tenantId, actor.tenantId),
            eq(crmConfigurations.id, preparedEntry.existing.id),
            eq(crmConfigurations.version, preparedEntry.existing.version),
          )).returning();
          if (!rows[0]) throw new ModuleCatalogError("Conflit de réactivation de configuration.", 409);
          await tx.insert(crmConfigurationVersions).values(snapshot(actor, rows[0]));
          items.push(decodeConfig(rows[0]));
        }
        managedEntries.push({ ...preparedEntry.entry, managed: false });
        continue;
      }
      const rows = await tx.insert(crmConfigurations).values({
        id: crypto.randomUUID(),
        tenantId: actor.tenantId,
        kind: preparedEntry.entry.kind,
        name: preparedEntry.entry.name,
        version: 1,
        active: 1,
        definition: JSON.stringify(preparedEntry.entry.definition),
      }).returning();
      await tx.insert(crmConfigurationVersions).values(snapshot(actor, rows[0]));
      managedEntries.push({ ...preparedEntry.entry, managed: true });
      items.push(decodeConfig(rows[0]));
    }

    const markerDefinition: InstallationMarker = {
      key: markerKey,
      templateKey: template.key,
      configs: managedEntries,
    };
    const markerValidation = validateConfiguration("template", markerDefinition);
    if (!markerValidation.ok) throw new ModuleCatalogError(`Marqueur d'installation invalide : ${markerValidation.error}`, 500);

    if (existingMarker) {
      const nextVersion = existingMarker.version + 1;
      const rows = await tx.update(crmConfigurations).set({
        name: `Installation ${template.name}`,
        active: 1,
        version: nextVersion,
        definition: JSON.stringify(markerValidation.value),
        updatedAt: new Date().toISOString(),
      }).where(and(
        eq(crmConfigurations.tenantId, actor.tenantId),
        eq(crmConfigurations.id, existingMarker.id),
        eq(crmConfigurations.version, existingMarker.version),
      )).returning();
      if (!rows[0]) throw new ModuleCatalogError("Conflit de réactivation du template.", 409);
      await tx.insert(crmConfigurationVersions).values(snapshot(actor, rows[0]));
    } else {
      const rows = await tx.insert(crmConfigurations).values({
        id: crypto.randomUUID(),
        tenantId: actor.tenantId,
        kind: "template",
        name: `Installation ${template.name}`,
        version: 1,
        active: 1,
        definition: JSON.stringify(markerValidation.value),
      }).returning();
      await tx.insert(crmConfigurationVersions).values(snapshot(actor, rows[0]));
    }
    return items;
  });

  await audit(actor, {
    action: existingMarker ? "template.reactivated" : "template.installed",
    resourceType: "template",
    resourceId: template.key,
    result: "success",
    details: { configurations: installed.map((item) => item.id) },
  });
  return { template: template.key, idempotent: false, reactivated: Boolean(existingMarker), items: installed };
}

export async function rollbackBuiltinTemplate(actor: AuthContext, templateKey: string) {
  const template = getBuiltinTemplate(templateKey);
  if (!template) throw new ModuleCatalogError("Template inconnu.", 404);
  const marker = await findConfig(actor.tenantId, "template", markerConfigKey(template.key));
  if (!marker) throw new ModuleCatalogError("Template non installé.", 404);
  if (marker.active !== 1) return { template: template.key, idempotent: true, rolledBack: true };
  const definition = parseMarker(marker.definition);
  if (!definition || definition.templateKey !== template.key) throw new ModuleCatalogError("Marqueur d'installation incohérent.", 409);

  const owned: Array<typeof crmConfigurations.$inferSelect> = [];
  for (const entry of definition.configs.filter((item) => item.managed)) {
    const existing = await findConfig(actor.tenantId, entry.kind, String(entry.definition.key));
    if (!existing) throw new ModuleCatalogError(`Configuration gérée absente : ${entry.name}.`, 409);
    if (stableDefinition(existing.definition) !== stableDefinition(JSON.stringify(entry.definition))) {
      throw new ModuleCatalogError(`Configuration gérée modifiée depuis l'installation : ${entry.name}.`, 409);
    }
    await assertSafeDeactivation(actor.tenantId, existing);
    owned.push(existing);
  }

  const db = getDb();
  await db.transaction(async (tx) => {
    for (const config of [...owned].reverse()) {
      if (config.active !== 1) continue;
      const rows = await tx.update(crmConfigurations).set({
        active: 0,
        version: config.version + 1,
        updatedAt: new Date().toISOString(),
      }).where(and(
        eq(crmConfigurations.tenantId, actor.tenantId),
        eq(crmConfigurations.id, config.id),
        eq(crmConfigurations.version, config.version),
      )).returning();
      if (!rows[0]) throw new ModuleCatalogError("Conflit pendant le rollback.", 409);
      await tx.insert(crmConfigurationVersions).values(snapshot(actor, rows[0]));
    }
    const markerRows = await tx.update(crmConfigurations).set({
      active: 0,
      version: marker.version + 1,
      updatedAt: new Date().toISOString(),
    }).where(and(
      eq(crmConfigurations.tenantId, actor.tenantId),
      eq(crmConfigurations.id, marker.id),
      eq(crmConfigurations.version, marker.version),
    )).returning();
    if (!markerRows[0]) throw new ModuleCatalogError("Conflit pendant le rollback du template.", 409);
    await tx.insert(crmConfigurationVersions).values(snapshot(actor, markerRows[0]));
  });

  await audit(actor, {
    action: "template.rolled_back",
    resourceType: "template",
    resourceId: template.key,
    result: "success",
    details: { deactivated: owned.map((item) => item.configKey) },
  });
  return { template: template.key, idempotent: false, rolledBack: true };
}

async function assertPrerequisites(tenantId: string, template: BuiltinTemplate) {
  for (const prerequisite of template.prerequisites ?? []) {
    const marker = await findConfig(tenantId, "template", markerConfigKey(prerequisite));
    if (!marker || marker.active !== 1) {
      throw new ModuleCatalogError(`Prérequis non satisfait : template ${prerequisite}.`, 409);
    }
  }
}

async function assertSafeDeactivation(tenantId: string, config: typeof crmConfigurations.$inferSelect) {
  const key = config.configKey;
  if (config.kind === "object") {
    const rows = await getDb().select({ id: crmRecords.id }).from(crmRecords)
      .where(and(eq(crmRecords.tenantId, tenantId), eq(crmRecords.type, key))).limit(1);
    if (rows[0]) throw new ModuleCatalogError(`Rollback refusé : l'objet ${key} contient des données.`, 409);
  }
  if (config.kind === "pipeline") {
    const rows = await getDb().select({ data: crmRecords.data }).from(crmRecords)
      .where(eq(crmRecords.tenantId, tenantId)).limit(2000);
    if (rows.some((row) => {
      try { return (JSON.parse(row.data) as Record<string, unknown>).pipelineKey === key; } catch { return false; }
    })) throw new ModuleCatalogError(`Rollback refusé : le pipeline ${key} est utilisé.`, 409);
  }
  if (config.kind === "relation") {
    const rows = await getDb().select({ id: crmRelations.id }).from(crmRelations)
      .where(and(eq(crmRelations.tenantId, tenantId), eq(crmRelations.relationType, key))).limit(1);
    if (rows[0]) throw new ModuleCatalogError(`Rollback refusé : la relation ${key} est utilisée.`, 409);
  }
  if (config.kind === "module") {
    const rows = await getDb().select().from(crmConfigurations).where(and(
      eq(crmConfigurations.tenantId, tenantId), eq(crmConfigurations.kind, "module"), eq(crmConfigurations.active, 1),
    )).limit(200);
    for (const row of rows) {
      if (row.id === config.id) continue;
      try {
        const parsed = JSON.parse(row.definition) as { dependsOn?: unknown };
        if (Array.isArray(parsed.dependsOn) && parsed.dependsOn.includes(key)) {
          throw new ModuleCatalogError(`Rollback refusé : le module ${row.name} dépend de ${key}.`, 409);
        }
      } catch (error) {
        if (error instanceof ModuleCatalogError) throw error;
      }
    }
  }
}

async function findConfig(tenantId: string, kind: string, key: string) {
  const rows = await getDb().select().from(crmConfigurations).where(and(
    eq(crmConfigurations.tenantId, tenantId),
    eq(crmConfigurations.kind, kind),
    eq(crmConfigurations.configKey, key),
  )).limit(1);
  return rows[0] ?? null;
}

function markerConfigKey(templateKey: string) {
  return `builtin_${templateKey}`;
}

function parseMarker(serialized: string): InstallationMarker | null {
  try {
    const value = JSON.parse(serialized) as Partial<InstallationMarker>;
    if (typeof value.key !== "string" || typeof value.templateKey !== "string" || !Array.isArray(value.configs)) return null;
    return value as InstallationMarker;
  } catch {
    return null;
  }
}

function stableDefinition(serialized: string) {
  try { return JSON.stringify(sortValue(JSON.parse(serialized))); } catch { return serialized; }
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortValue(item)]));
}

function snapshot(actor: AuthContext, config: typeof crmConfigurations.$inferSelect) {
  return {
    id: `${config.id}:${config.version}`,
    tenantId: actor.tenantId,
    configurationId: config.id,
    version: config.version,
    name: config.name,
    active: config.active,
    definition: config.definition,
    createdBy: actor.userId,
  };
}

function decodeConfig(row: typeof crmConfigurations.$inferSelect) {
  return {
    ...row,
    active: row.active === 1,
    definition: JSON.parse(row.definition) as Record<string, unknown>,
  };
}

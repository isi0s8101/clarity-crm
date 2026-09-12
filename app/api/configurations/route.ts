import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gt } from "drizzle-orm";

import { getDb } from "@/db";
import {
  crmConfigurations,
  crmConfigurationVersions,
  crmRecords,
  crmRelations,
} from "@/db/schema";
import {
  audit,
  authErrorResponse,
  requirePermission,
  resolveAuthContext,
} from "@/lib/authz";
import {
  isValidConfigKind,
  isCoreRecordType,
  normalizeWebhookUrl,
  validateConfiguration,
} from "@/lib/crm-policy.js";
import { validateCustomFieldValues } from "@/lib/crm-runtime-validation";
import { hostMatchesAllowedWebhookHosts } from "@/lib/webhook-security.js";
import { BUILTIN_TEMPLATES, getBuiltinTemplate } from "@/lib/crm-templates";
import { assertSameOriginMutation } from "@/lib/native-auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "crm_configuration", "read");
    const kind = request.nextUrl.searchParams.get("kind");
    const historyId = request.nextUrl.searchParams.get("historyId");
    const db = getDb();

    if (historyId) {
      await requirePermission(actor, "crm_configuration", "administer");
      const versions = await db
        .select()
        .from(crmConfigurationVersions)
        .where(
          and(
            eq(crmConfigurationVersions.tenantId, actor.tenantId),
            eq(crmConfigurationVersions.configurationId, historyId),
          ),
        )
        .orderBy(desc(crmConfigurationVersions.version))
        .limit(100);
      return NextResponse.json({ items: versions.map(decodeVersion) });
    }

    if (kind && !isValidConfigKind(kind)) {
      return NextResponse.json({ error: "Type de configuration invalide." }, { status: 400 });
    }
    const all = request.nextUrl.searchParams.get("all") === "1" && actor.role === "admin";
    const filters = [eq(crmConfigurations.tenantId, actor.tenantId)];
    if (kind) filters.push(eq(crmConfigurations.kind, kind));
    if (!all) filters.push(eq(crmConfigurations.active, 1));
    const rows = await db
      .select()
      .from(crmConfigurations)
      .where(and(...filters))
      .orderBy(desc(crmConfigurations.updatedAt))
      .limit(300);

    return NextResponse.json({
      items: rows.map(decodeConfiguration),
      builtinTemplates: !kind || kind === "template" ? BUILTIN_TEMPLATES : undefined,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("config:list", error);
    return NextResponse.json({ error: "Configurations indisponibles." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "crm_configuration", "administer");
    const body = (await request.json()) as Record<string, unknown>;

    if (body.intent === "apply-template") {
      const templateKey = typeof body.templateKey === "string" ? body.templateKey : "";
      const template = getBuiltinTemplate(templateKey);
      if (!template) {
        return NextResponse.json({ error: "Template inconnu." }, { status: 404 });
      }
      const applied = await applyTemplate(actor, template.configs);
      await audit(actor, {
        action: "template.applied",
        resourceType: "template",
        resourceId: template.key,
        result: "success",
        details: { applied: applied.map((item) => item.id) },
      });
      return NextResponse.json({ template: template.key, items: applied }, { status: 201 });
    }

    const kind = typeof body.kind === "string" ? body.kind : "";
    const name = normalizeName(body.name);
    const definition = asObject(body.definition);
    if (!isValidConfigKind(kind) || !name || !definition) {
      return NextResponse.json({ error: "Configuration invalide." }, { status: 400 });
    }
    const validation = validateConfiguration(kind, definition);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const webhookError = validateWebhookNetworkPolicy(kind, validation.value);
    if (webhookError) return NextResponse.json({ error: webhookError }, { status: 400 });
    await assertConfigurationReferences(actor.tenantId, kind, validation.value);

    const db = getDb();
    if (await configurationKeyExists(actor.tenantId, kind, validation.value)) {
      return NextResponse.json({ error: "Une configuration avec cette clé existe déjà." }, { status: 409 });
    }

    const id = crypto.randomUUID();
    const active = body.active === false ? 0 : 1;
    const inserted = await db.transaction(async (tx) => {
      const rows = await tx.insert(crmConfigurations).values({
        id,
        tenantId: actor.tenantId,
        kind,
        name,
        version: 1,
        active,
        definition: JSON.stringify(validation.value),
      }).returning();
      await tx.insert(crmConfigurationVersions).values(versionSnapshot(actor.tenantId, actor.userId, rows[0]));
      return rows;
    });
    await audit(actor, {
      action: "crm_configuration.created",
      resourceType: kind,
      resourceId: id,
      result: "success",
      after: decodeConfiguration(inserted[0]),
    });
    return NextResponse.json({ item: decodeConfiguration(inserted[0]) }, { status: 201 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof ConfigurationRequestError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (isPostgresError(error, "23505")) {
      return NextResponse.json({ error: "Une configuration avec cette clé existe déjà." }, { status: 409 });
    }
    console.error("config:create", error);
    return NextResponse.json({ error: "Création de configuration impossible." }, { status: 503 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "crm_configuration", "administer");
    const body = (await request.json()) as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id : "";
    const db = getDb();
    const rows = await db
      .select()
      .from(crmConfigurations)
      .where(and(eq(crmConfigurations.id, id), eq(crmConfigurations.tenantId, actor.tenantId)))
      .limit(1);
    const existing = rows[0];
    if (!existing) return NextResponse.json({ error: "Configuration introuvable." }, { status: 404 });

    let name = existing.name;
    let active = existing.active;
    let definition = JSON.parse(existing.definition) as Record<string, unknown>;

    if (body.restoreVersion !== undefined) {
      const version = Number(body.restoreVersion);
      if (!Number.isInteger(version) || version < 1) {
        return NextResponse.json({ error: "Version de restauration invalide." }, { status: 400 });
      }
      const snapshots = await db
        .select()
        .from(crmConfigurationVersions)
        .where(
          and(
            eq(crmConfigurationVersions.tenantId, actor.tenantId),
            eq(crmConfigurationVersions.configurationId, id),
            eq(crmConfigurationVersions.version, version),
          ),
        )
        .limit(1);
      if (!snapshots[0]) return NextResponse.json({ error: "Version introuvable." }, { status: 404 });
      name = snapshots[0].name;
      active = snapshots[0].active;
      definition = JSON.parse(snapshots[0].definition) as Record<string, unknown>;
    } else {
      if (body.name !== undefined) {
        const candidate = normalizeName(body.name);
        if (!candidate) return NextResponse.json({ error: "Nom invalide." }, { status: 400 });
        name = candidate;
      }
      if (body.active !== undefined) active = body.active === true ? 1 : 0;
      if (body.definition !== undefined) {
        const candidate = asObject(body.definition);
        if (!candidate) return NextResponse.json({ error: "Définition invalide." }, { status: 400 });
        definition = candidate;
      }
    }

    const validation = validateConfiguration(existing.kind, definition);
    if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });
    const webhookError = validateWebhookNetworkPolicy(existing.kind, validation.value);
    if (webhookError) return NextResponse.json({ error: webhookError }, { status: 400 });
    const existingDefinition = JSON.parse(existing.definition) as Record<string, unknown>;
    if (existingDefinition.key !== validation.value.key) {
      return NextResponse.json({ error: "La clé d'une configuration existante est immuable." }, { status: 409 });
    }
    await assertConfigurationReferences(actor.tenantId, existing.kind, validation.value);
    await assertConfigurationCompatible(actor.tenantId, existing.kind, validation.value, active === 1, existingDefinition);
    if (existing.kind === "module" && active === 0 && existing.active === 1) {
      const blockedBy = await findActiveDependentModule(actor.tenantId, validation.value);
      if (blockedBy) {
        return NextResponse.json({ error: `Module requis par « ${blockedBy} ».` }, { status: 409 });
      }
    }

    const nextVersion = existing.version + 1;
    const updated = await db.transaction(async (tx) => {
      const rows = await tx
        .update(crmConfigurations)
        .set({
          name,
          active,
          definition: JSON.stringify(validation.value),
          version: nextVersion,
          updatedAt: new Date().toISOString(),
        })
        .where(and(
          eq(crmConfigurations.id, id),
          eq(crmConfigurations.tenantId, actor.tenantId),
          eq(crmConfigurations.version, existing.version),
        ))
        .returning();
      if (!rows[0]) throw new ConfigurationRequestError("Configuration modifiée simultanément, recharge requise.", 409);
      await tx.insert(crmConfigurationVersions).values(versionSnapshot(actor.tenantId, actor.userId, rows[0]));
      return rows;
    });
    await audit(actor, {
      action: body.restoreVersion !== undefined ? "crm_configuration.restored" : "crm_configuration.updated",
      resourceType: existing.kind,
      resourceId: id,
      result: "success",
      before: decodeConfiguration(existing),
      after: decodeConfiguration(updated[0]),
    });
    return NextResponse.json({ item: decodeConfiguration(updated[0]) });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof ConfigurationRequestError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (isPostgresError(error, "23505")) {
      return NextResponse.json({ error: "Conflit de version ou de clé de configuration." }, { status: 409 });
    }
    console.error("config:update", error);
    return NextResponse.json({ error: "Mise à jour de configuration impossible." }, { status: 503 });
  }
}

async function applyTemplate(
  actor: Awaited<ReturnType<typeof resolveAuthContext>>,
  configs: Array<{ kind: string; name: string; definition: Record<string, unknown> }>,
) {
  const db = getDb();
  const applied = [];
  for (const entry of configs) {
    const validation = validateConfiguration(entry.kind, entry.definition);
    if (!validation.ok) throw new Error(validation.error);
    if (await configurationKeyExists(actor.tenantId, entry.kind, validation.value)) continue;
    await assertConfigurationReferences(actor.tenantId, entry.kind, validation.value);
    const inserted = await db.transaction(async (tx) => {
      const rows = await tx.insert(crmConfigurations).values({
        id: crypto.randomUUID(),
        tenantId: actor.tenantId,
        kind: entry.kind,
        name: entry.name,
        version: 1,
        active: 1,
        definition: JSON.stringify(validation.value),
      }).returning();
      await tx.insert(crmConfigurationVersions).values(versionSnapshot(actor.tenantId, actor.userId, rows[0]));
      return rows;
    });
    applied.push(decodeConfiguration(inserted[0]));
  }
  return applied;
}

async function configurationKeyExists(
  tenantId: string,
  kind: string,
  definition: Record<string, unknown>,
) {
  const key = definition.key;
  if (typeof key !== "string") return false;
  const db = getDb();
  const rows = await db
    .select({ definition: crmConfigurations.definition })
    .from(crmConfigurations)
    .where(and(eq(crmConfigurations.tenantId, tenantId), eq(crmConfigurations.kind, kind)))
    .limit(300);
  return rows.some((row) => {
    try {
      const parsed = JSON.parse(row.definition) as { key?: unknown };
      return parsed.key === key;
    } catch {
      return false;
    }
  });
}

async function findActiveDependentModule(tenantId: string, definition: Record<string, unknown>) {
  const key = definition.key;
  if (typeof key !== "string") return null;
  const db = getDb();
  const rows = await db
    .select()
    .from(crmConfigurations)
    .where(
      and(
        eq(crmConfigurations.tenantId, tenantId),
        eq(crmConfigurations.kind, "module"),
        eq(crmConfigurations.active, 1),
      ),
    )
    .limit(200);
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.definition) as { key?: string; dependsOn?: unknown };
      if (parsed.key !== key && Array.isArray(parsed.dependsOn) && parsed.dependsOn.includes(key)) {
        return row.name;
      }
    } catch {
      // Une configuration invalide est ignorée ici et sera signalée par l'audit de configuration.
    }
  }
  return null;
}

function versionSnapshot(
  tenantId: string,
  actorId: string,
  config: typeof crmConfigurations.$inferSelect,
) {
  return {
    id: `${config.id}:${config.version}`,
    tenantId,
    configurationId: config.id,
    version: config.version,
    name: config.name,
    active: config.active,
    definition: config.definition,
    createdBy: actorId,
  };
}

function validateWebhookNetworkPolicy(kind: string, definition: Record<string, unknown>) {
  if (kind !== "webhook" || definition.direction !== "outbound") return null;
  const allowPrivate = process.env.CLARITY_WEBHOOK_ALLOW_PRIVATE_E2E === "1";
  const url = normalizeWebhookUrl(definition.url, { allowPrivate });
  if (!url) return "URL webhook refusée : HTTPS public requis.";
  const hostname = new URL(url).hostname;
  if (!hostMatchesAllowedWebhookHosts(hostname, process.env.CLARITY_WEBHOOK_ALLOWED_HOSTS)) {
    return "URL webhook refusée : hôte hors allowlist.";
  }
  return null;
}

function decodeConfiguration(row: typeof crmConfigurations.$inferSelect) {
  let definition: Record<string, unknown> = {};
  try {
    definition = JSON.parse(row.definition) as Record<string, unknown>;
  } catch {
    definition = {};
  }
  return { ...row, active: row.active === 1, definition };
}

function decodeVersion(row: typeof crmConfigurationVersions.$inferSelect) {
  let definition: Record<string, unknown> = {};
  try {
    definition = JSON.parse(row.definition) as Record<string, unknown>;
  } catch {
    definition = {};
  }
  return { ...row, active: row.active === 1, definition };
}

function normalizeName(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 120 ? normalized : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

class ConfigurationRequestError extends Error {
  constructor(message: string, readonly status: 400 | 409) {
    super(message);
  }
}

function isPostgresError(error: unknown, code: string) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

async function assertConfigurationReferences(
  tenantId: string,
  kind: string,
  definition: Record<string, unknown>,
) {
  if (kind === "object") {
    if (isCoreRecordType(definition.key)) {
      throw new ConfigurationRequestError("Un objet personnalisé ne peut pas remplacer un objet natif.", 409);
    }
    for (const rawField of Array.isArray(definition.fields) ? definition.fields : []) {
      const field = asObject(rawField);
      if (field?.type === "relation" && typeof field.targetType === "string") {
        await requireConfiguredObjectType(tenantId, field.targetType);
      }
    }
    return;
  }

  const referencedTypes = new Set<string>();
  if ((kind === "pipeline" || kind === "form") && typeof definition.objectType === "string") {
    referencedTypes.add(definition.objectType);
  }
  if (kind === "relation") {
    if (typeof definition.sourceType === "string") referencedTypes.add(definition.sourceType);
    if (typeof definition.targetType === "string") referencedTypes.add(definition.targetType);
  }
  for (const type of referencedTypes) await requireConfiguredObjectType(tenantId, type);

  if (kind === "form" && typeof definition.objectType === "string" && !isCoreRecordType(definition.objectType)) {
    const objectDefinition = await findActiveConfigurationDefinition(tenantId, "object", definition.objectType);
    const objectFields = new Map<string, Record<string, unknown>>();
    for (const rawField of Array.isArray(objectDefinition?.fields) ? objectDefinition.fields : []) {
      const field = asObject(rawField);
      if (field && typeof field.key === "string") objectFields.set(field.key, field);
    }
    const formFieldKeys = new Set<string>();
    for (const rawField of Array.isArray(definition.fields) ? definition.fields : []) {
      const field = asObject(rawField);
      const key = typeof field?.key === "string" ? field.key : "";
      formFieldKeys.add(key);
      if (key !== "title" && key !== "status" && !objectFields.has(key)) {
        throw new ConfigurationRequestError(`Le formulaire référence un champ inconnu : ${key}.`, 400);
      }
      if (objectFields.get(key)?.required === true && field?.required !== true) {
        throw new ConfigurationRequestError(`Le formulaire doit conserver le champ obligatoire : ${key}.`, 400);
      }
    }
    for (const [key, field] of objectFields) {
      if (field.required === true && !formFieldKeys.has(key)) {
        throw new ConfigurationRequestError(`Le formulaire omet le champ obligatoire : ${key}.`, 400);
      }
    }
  }
}

async function requireConfiguredObjectType(tenantId: string, type: string) {
  if (isCoreRecordType(type)) return;
  if (!(await findActiveConfigurationDefinition(tenantId, "object", type))) {
    throw new ConfigurationRequestError(`Objet métier référencé inconnu ou désactivé : ${type}.`, 400);
  }
}

async function findActiveConfigurationDefinition(tenantId: string, kind: string, key: string) {
  const rows = await getDb()
    .select({ definition: crmConfigurations.definition })
    .from(crmConfigurations)
    .where(and(
      eq(crmConfigurations.tenantId, tenantId),
      eq(crmConfigurations.kind, kind),
      eq(crmConfigurations.active, 1),
    ))
    .limit(300);
  for (const row of rows) {
    try {
      const definition = JSON.parse(row.definition) as Record<string, unknown>;
      if (definition.key === key) return definition;
    } catch {
      // Une configuration illisible ne satisfait jamais une dépendance.
    }
  }
  return null;
}

async function assertConfigurationCompatible(
  tenantId: string,
  kind: string,
  definition: Record<string, unknown>,
  active: boolean,
  previous: Record<string, unknown>,
) {
  const key = String(definition.key ?? "");
  if (kind === "object") {
    const currentFieldKeys = new Set(
      (Array.isArray(definition.fields) ? definition.fields : [])
        .map(asObject)
        .filter((field): field is Record<string, unknown> => Boolean(field))
        .map((field) => field.key)
        .filter((fieldKey): fieldKey is string => typeof fieldKey === "string"),
    );
    const previousFieldKeys = new Set(
      (Array.isArray(previous.fields) ? previous.fields : [])
        .map(asObject)
        .filter((field): field is Record<string, unknown> => Boolean(field))
        .map((field) => field.key)
        .filter((fieldKey): fieldKey is string => typeof fieldKey === "string"),
    );
    const removedFieldKeys = [...previousFieldKeys].filter((fieldKey) => !currentFieldKeys.has(fieldKey));
    let cursor = "";
    let hasRecords = false;
    while (true) {
      const rows = await getDb()
        .select({ id: crmRecords.id, data: crmRecords.data })
        .from(crmRecords)
        .where(and(eq(crmRecords.tenantId, tenantId), eq(crmRecords.type, key), gt(crmRecords.id, cursor)))
        .orderBy(crmRecords.id)
        .limit(250);
      if (rows.length === 0) break;
      hasRecords = true;
      for (const row of rows) {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(row.data) as Record<string, unknown>;
        } catch {
          throw new ConfigurationRequestError(`La fiche ${row.id} contient des données illisibles.`, 409);
        }
        const removedField = removedFieldKeys.find((fieldKey) => data[fieldKey] !== undefined && data[fieldKey] !== null);
        if (removedField) {
          throw new ConfigurationRequestError(`Le champ ${removedField} contient encore des données dans la fiche ${row.id}.`, 409);
        }
        try {
          await validateCustomFieldValues(tenantId, definition, data);
        } catch (error) {
          const reason = error instanceof Error ? error.message : "données incompatibles";
          throw new ConfigurationRequestError(`Configuration incompatible avec la fiche ${row.id} : ${reason}`, 409);
        }
      }
      cursor = rows.at(-1)?.id ?? cursor;
      if (rows.length < 250) break;
    }
    if (!active && hasRecords) {
      throw new ConfigurationRequestError("Impossible de désactiver un objet qui contient des fiches.", 409);
    }

    const dependentConfigurations = await getDb()
      .select({ kind: crmConfigurations.kind, name: crmConfigurations.name, definition: crmConfigurations.definition })
      .from(crmConfigurations)
      .where(and(eq(crmConfigurations.tenantId, tenantId), eq(crmConfigurations.active, 1)))
      .limit(500);
    for (const dependent of dependentConfigurations) {
      let candidate: Record<string, unknown>;
      try { candidate = JSON.parse(dependent.definition) as Record<string, unknown>; } catch { continue; }
      const referencesObject =
        ((dependent.kind === "pipeline" || dependent.kind === "form") && candidate.objectType === key) ||
        (dependent.kind === "relation" && (candidate.sourceType === key || candidate.targetType === key));
      if (!referencesObject) continue;
      if (!active) {
        throw new ConfigurationRequestError(`Objet requis par la configuration active « ${dependent.name} ».`, 409);
      }
      if (dependent.kind === "form") {
        for (const rawField of Array.isArray(candidate.fields) ? candidate.fields : []) {
          const formField = asObject(rawField);
          const fieldKey = typeof formField?.key === "string" ? formField.key : "";
          if (fieldKey !== "title" && fieldKey !== "status" && !currentFieldKeys.has(fieldKey)) {
            throw new ConfigurationRequestError(`Le formulaire « ${dependent.name} » utilise encore le champ ${fieldKey}.`, 409);
          }
        }
      }
    }
  }

  if (kind === "pipeline") {
    const stages = new Set(
      (Array.isArray(definition.stages) ? definition.stages : [])
        .map(asObject)
        .filter((stage): stage is Record<string, unknown> => Boolean(stage))
        .map((stage) => stage.key),
    );
    const rows = await getDb()
      .select({ id: crmRecords.id, type: crmRecords.type, data: crmRecords.data })
      .from(crmRecords)
      .where(eq(crmRecords.tenantId, tenantId));
    for (const row of rows) {
      let data: Record<string, unknown>;
      try { data = JSON.parse(row.data) as Record<string, unknown>; } catch { continue; }
      if (data.pipelineKey !== key) continue;
      if (row.type !== definition.objectType || !stages.has(data.stage)) {
        throw new ConfigurationRequestError(`Pipeline incompatible avec la fiche ${row.id}.`, 409);
      }
      if (!active) throw new ConfigurationRequestError("Impossible de désactiver un pipeline utilisé.", 409);
    }
  }

  if (kind === "relation") {
    const existing = await getDb()
      .select({ id: crmRelations.id })
      .from(crmRelations)
      .where(and(eq(crmRelations.tenantId, tenantId), eq(crmRelations.relationType, key)))
      .limit(1);
    if (existing[0] && !active) {
      throw new ConfigurationRequestError("Impossible de désactiver une relation encore utilisée.", 409);
    }
    if (
      existing[0] &&
      (previous.sourceType !== definition.sourceType ||
        previous.targetType !== definition.targetType ||
        previous.cardinality !== definition.cardinality)
    ) {
      throw new ConfigurationRequestError("Impossible de modifier la structure d'une relation encore utilisée.", 409);
    }
  }
}

import { env } from "cloudflare:workers";
import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { getDb } from "@/db";
import {
  crmConfigurations,
  crmConfigurationVersions,
} from "@/db/schema";
import {
  audit,
  authErrorResponse,
  requirePermission,
  resolveAuthContext,
} from "@/lib/authz";
import {
  isValidConfigKind,
  normalizeWebhookUrl,
  validateConfiguration,
} from "@/lib/crm-policy.js";
import { BUILTIN_TEMPLATES, getBuiltinTemplate } from "@/lib/crm-templates";

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

    const db = getDb();
    if (await configurationKeyExists(actor.tenantId, kind, validation.value)) {
      return NextResponse.json({ error: "Une configuration avec cette clé existe déjà." }, { status: 409 });
    }

    const id = crypto.randomUUID();
    const active = body.active === false ? 0 : 1;
    const inserted = await db.insert(crmConfigurations).values({
      id,
      tenantId: actor.tenantId,
      kind,
      name,
      version: 1,
      active,
      definition: JSON.stringify(validation.value),
    }).returning();
    await saveVersion(actor.tenantId, actor.userId, inserted[0]);
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
    console.error("config:create", error);
    return NextResponse.json({ error: "Création de configuration impossible." }, { status: 503 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
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
    if (existing.kind === "module" && active === 0 && existing.active === 1) {
      const blockedBy = await findActiveDependentModule(actor.tenantId, validation.value);
      if (blockedBy) {
        return NextResponse.json({ error: `Module requis par « ${blockedBy} ».` }, { status: 409 });
      }
    }

    const nextVersion = existing.version + 1;
    const updated = await db
      .update(crmConfigurations)
      .set({
        name,
        active,
        definition: JSON.stringify(validation.value),
        version: nextVersion,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(crmConfigurations.id, id), eq(crmConfigurations.tenantId, actor.tenantId)))
      .returning();
    await saveVersion(actor.tenantId, actor.userId, updated[0]);
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
    const inserted = await db.insert(crmConfigurations).values({
      id: crypto.randomUUID(),
      tenantId: actor.tenantId,
      kind: entry.kind,
      name: entry.name,
      version: 1,
      active: 1,
      definition: JSON.stringify(validation.value),
    }).returning();
    await saveVersion(actor.tenantId, actor.userId, inserted[0]);
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

async function saveVersion(
  tenantId: string,
  actorId: string,
  config: typeof crmConfigurations.$inferSelect,
) {
  const db = getDb();
  await db.insert(crmConfigurationVersions).values({
    id: `${config.id}:${config.version}`,
    tenantId,
    configurationId: config.id,
    version: config.version,
    name: config.name,
    active: config.active,
    definition: config.definition,
    createdBy: actorId,
  });
}

function validateWebhookNetworkPolicy(kind: string, definition: Record<string, unknown>) {
  if (kind !== "webhook" || definition.direction !== "outbound") return null;
  const allowPrivate = ((env as unknown as Record<string, unknown>).CLARITY_WEBHOOK_ALLOW_PRIVATE_E2E) === "1";
  const url = normalizeWebhookUrl(definition.url, { allowPrivate });
  return url ? null : "URL webhook refusée : HTTPS public requis.";
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

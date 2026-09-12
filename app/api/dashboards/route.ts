import { and, desc, eq, inArray } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/db";
import { dashboards, dashboardWidgets } from "@/db/schema";
import { audit, authErrorResponse, requirePermission, resolveAuthContext, type PermissionScope } from "@/lib/authz";
import { assertSameOriginMutation } from "@/lib/native-auth";

const SCOPES = new Set(["personal", "team", "tenant"]);
const WIDGET_TYPES = new Set(["metric", "pipeline", "activity", "tasks"]);
const METRICS = new Set(["openOpportunities", "pipelineAmountCents", "wonOpportunities", "openTasks", "overdueTasks"]);

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    const permission = await requirePermission(actor, "dashboard", "read");
    const db = getDb();
    const rows = await db.select().from(dashboards).where(and(eq(dashboards.tenantId, actor.tenantId), eq(dashboards.status, "active"))).orderBy(desc(dashboards.updatedAt)).limit(100);
    const accessible = rows.filter((row) => canAccess(actor, permission, row));
    const ids = accessible.map((item) => item.id);
    const widgets = ids.length ? await db.select().from(dashboardWidgets).where(and(eq(dashboardWidgets.tenantId, actor.tenantId), inArray(dashboardWidgets.dashboardId, ids))).orderBy(dashboardWidgets.position).limit(1200) : [];
    return NextResponse.json({ items: accessible.map((item) => decode(item, widgets.filter((widget) => widget.dashboardId === item.id))) });
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    console.error("dashboards:list", error);
    return NextResponse.json({ error: "Dashboards indisponibles." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const permission = await requirePermission(actor, "dashboard", "create");
    const input = validate(await request.json() as Record<string, unknown>);
    if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });
    if (!canPublish(permission, input.scope)) return NextResponse.json({ error: "Partage non autorisé." }, { status: 403 });
    const db = getDb();
    const created = await db.transaction(async (tx) => {
      if (input.isDefault) await tx.update(dashboards).set({ isDefault: 0, updatedAt: new Date().toISOString() }).where(and(eq(dashboards.tenantId, actor.tenantId), eq(dashboards.ownerId, actor.userId), eq(dashboards.isDefault, 1)));
      const dashboard = (await tx.insert(dashboards).values({ id: crypto.randomUUID(), tenantId: actor.tenantId, ownerId: actor.userId, teamId: input.scope === "team" ? actor.teamId : null, scope: input.scope, name: input.name, isDefault: input.isDefault ? 1 : 0 }).returning())[0];
      const widgets = input.widgets.length ? await tx.insert(dashboardWidgets).values(input.widgets.map((widget, position) => ({ id: crypto.randomUUID(), tenantId: actor.tenantId, dashboardId: dashboard.id, widgetType: widget.widgetType, position, configuration: JSON.stringify(widget.configuration) }))).returning() : [];
      return { dashboard, widgets };
    });
    const item = decode(created.dashboard, created.widgets);
    await audit(actor, { action: "dashboard.created", resourceType: "dashboard", resourceId: item.id, result: "success", after: item });
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    console.error("dashboards:create", error);
    return NextResponse.json({ error: "Création de dashboard impossible." }, { status: 503 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const permission = await requirePermission(actor, "dashboard", "update");
    const body = await request.json() as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id : "";
    const expectedVersion = Number(body.version);
    if (!id || !Number.isInteger(expectedVersion) || expectedVersion < 1) return NextResponse.json({ error: "Version de dashboard requise." }, { status: 400 });
    const db = getDb();
    const current = (await db.select().from(dashboards).where(and(eq(dashboards.id, id), eq(dashboards.tenantId, actor.tenantId))).limit(1))[0];
    if (!current || !canAccess(actor, permission, current)) return NextResponse.json({ error: "Dashboard introuvable." }, { status: 404 });
    if (current.version !== expectedVersion) return NextResponse.json({ error: "Le dashboard a été modifié par un autre utilisateur." }, { status: 409 });
    const existingWidgets = await db.select().from(dashboardWidgets).where(and(eq(dashboardWidgets.dashboardId, id), eq(dashboardWidgets.tenantId, actor.tenantId))).orderBy(dashboardWidgets.position).limit(100);
    const input = validate({ name: current.name, scope: current.scope, isDefault: current.isDefault === 1, widgets: existingWidgets.map((item) => ({ widgetType: item.widgetType, configuration: parseConfiguration(item.configuration) })), ...body });
    if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });
    if (!canPublish(permission, input.scope)) return NextResponse.json({ error: "Partage non autorisé." }, { status: 403 });
    const updated = await db.transaction(async (tx) => {
      if (input.isDefault) await tx.update(dashboards).set({ isDefault: 0, updatedAt: new Date().toISOString() }).where(and(eq(dashboards.tenantId, actor.tenantId), eq(dashboards.ownerId, actor.userId), eq(dashboards.isDefault, 1)));
      const dashboard = (await tx.update(dashboards).set({ name: input.name, scope: input.scope, teamId: input.scope === "team" ? actor.teamId : null, isDefault: input.isDefault ? 1 : 0, version: current.version + 1, updatedAt: new Date().toISOString() }).where(and(eq(dashboards.id, id), eq(dashboards.tenantId, actor.tenantId), eq(dashboards.version, expectedVersion))).returning())[0];
      if (!dashboard) throw new ConflictError();
      await tx.delete(dashboardWidgets).where(and(eq(dashboardWidgets.dashboardId, id), eq(dashboardWidgets.tenantId, actor.tenantId)));
      const widgets = input.widgets.length ? await tx.insert(dashboardWidgets).values(input.widgets.map((widget, position) => ({ id: crypto.randomUUID(), tenantId: actor.tenantId, dashboardId: id, widgetType: widget.widgetType, position, configuration: JSON.stringify(widget.configuration) }))).returning() : [];
      return { dashboard, widgets };
    });
    const item = decode(updated.dashboard, updated.widgets);
    await audit(actor, { action: "dashboard.updated", resourceType: "dashboard", resourceId: id, result: "success", before: decode(current, existingWidgets), after: item });
    return NextResponse.json({ item });
  } catch (error) {
    if (error instanceof ConflictError) return NextResponse.json({ error: "Conflit de mise à jour." }, { status: 409 });
    const response = authErrorResponse(error);
    if (response) return response;
    console.error("dashboards:update", error);
    return NextResponse.json({ error: "Mise à jour de dashboard impossible." }, { status: 503 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const permission = await requirePermission(actor, "dashboard", "delete");
    const id = request.nextUrl.searchParams.get("id") ?? "";
    const db = getDb();
    const current = (await db.select().from(dashboards).where(and(eq(dashboards.id, id), eq(dashboards.tenantId, actor.tenantId))).limit(1))[0];
    if (!current || !canAccess(actor, permission, current)) return NextResponse.json({ error: "Dashboard introuvable." }, { status: 404 });
    const item = (await db.update(dashboards).set({ status: "archived", version: current.version + 1, updatedAt: new Date().toISOString() }).where(and(eq(dashboards.id, id), eq(dashboards.tenantId, actor.tenantId), eq(dashboards.version, current.version))).returning())[0];
    if (!item) return NextResponse.json({ error: "Conflit de suppression." }, { status: 409 });
    await audit(actor, { action: "dashboard.archived", resourceType: "dashboard", resourceId: id, result: "success", before: current, after: item });
    return NextResponse.json({ item: decode(item, []) });
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    console.error("dashboards:archive", error);
    return NextResponse.json({ error: "Suppression de dashboard impossible." }, { status: 503 });
  }
}

function validate(body: Record<string, unknown>): { ok: true; name: string; scope: string; isDefault: boolean; widgets: Array<{ widgetType: string; configuration: Record<string, unknown> }> } | { ok: false; error: string } {
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
  const scope = typeof body.scope === "string" ? body.scope : "personal";
  const widgets = Array.isArray(body.widgets) && body.widgets.length <= 12 ? body.widgets.map(validateWidget) : null;
  if (!name || !SCOPES.has(scope) || !widgets || widgets.some((item) => !item)) return { ok: false, error: "Dashboard invalide." };
  return { ok: true, name, scope, isDefault: body.isDefault === true, widgets: widgets as Array<{ widgetType: string; configuration: Record<string, unknown> }> };
}
function validateWidget(value: unknown): { widgetType: string; configuration: Record<string, unknown> } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const widgetType = typeof candidate.widgetType === "string" ? candidate.widgetType : "";
  const configuration = candidate.configuration;
  if (!WIDGET_TYPES.has(widgetType) || !configuration || typeof configuration !== "object" || Array.isArray(configuration) || JSON.stringify(configuration).length > 4096) return null;
  const metric = (configuration as Record<string, unknown>).metric;
  if (widgetType === "metric" && (typeof metric !== "string" || !METRICS.has(metric))) return null;
  return { widgetType, configuration: configuration as Record<string, unknown> };
}
function parseConfiguration(value: string) { try { const parsed = JSON.parse(value) as unknown; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
function decode<T extends { isDefault: number }>(row: T, widgets: Array<{ configuration: string }>): Omit<T, "isDefault"> & { isDefault: boolean; widgets: Array<Omit<typeof widgets[number], "configuration"> & { configuration: Record<string, unknown> }> } { return { ...row, isDefault: row.isDefault === 1, widgets: widgets.map((widget) => ({ ...widget, configuration: parseConfiguration(widget.configuration) })) } as Omit<T, "isDefault"> & { isDefault: boolean; widgets: Array<Omit<typeof widgets[number], "configuration"> & { configuration: Record<string, unknown> }> }; }
function canPublish(permission: PermissionScope, scope: string) { return scope === "personal" || permission === "tenant" || (scope === "team" && permission === "team"); }
function canAccess(actor: { userId: string; teamId: string }, permission: PermissionScope, row: { ownerId: string; teamId: string | null; scope: string }) { if (row.ownerId === actor.userId) return true; if (permission === "personal") return false; if (row.scope === "tenant") return permission === "tenant"; return row.scope === "team" && row.teamId === actor.teamId; }
class ConflictError extends Error {}

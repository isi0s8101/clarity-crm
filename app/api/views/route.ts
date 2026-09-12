import { and, desc, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/db";
import { savedViews } from "@/db/schema";
import { audit, authErrorResponse, requirePermission, resolveAuthContext, type PermissionScope } from "@/lib/authz";
import { assertSameOriginMutation } from "@/lib/native-auth";

const SCOPES = new Set(["personal", "team", "tenant"]);

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    const permission = await requirePermission(actor, "saved_view", "read");
    const objectType = request.nextUrl.searchParams.get("objectType")?.trim() ?? "";
    const db = getDb();
    const rows = await db.select().from(savedViews).where(and(
      eq(savedViews.tenantId, actor.tenantId),
      eq(savedViews.status, "active"),
      ...(objectType ? [eq(savedViews.objectType, objectType)] : []),
    )).orderBy(desc(savedViews.updatedAt)).limit(200);
    return NextResponse.json({ items: rows.filter((row) => canAccess(actor, permission, row)) });
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    console.error("views:list", error);
    return NextResponse.json({ error: "Vues indisponibles." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const permission = await requirePermission(actor, "saved_view", "create");
    const body = await request.json() as Record<string, unknown>;
    const input = validate(body);
    if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });
    if (!canPublish(permission, input.scope)) return NextResponse.json({ error: "Partage non autorisé." }, { status: 403 });
    const db = getDb();
    if (input.isDefault) await clearDefault(db, actor.tenantId, actor.userId, input.objectType);
    const item = (await db.insert(savedViews).values({
      id: crypto.randomUUID(), tenantId: actor.tenantId, ownerId: actor.userId,
      teamId: input.scope === "team" ? actor.teamId : null, scope: input.scope,
      objectType: input.objectType, name: input.name, definition: JSON.stringify(input.definition),
      isDefault: input.isDefault ? 1 : 0,
    }).returning())[0];
    await audit(actor, { action: "saved_view.created", resourceType: "saved_view", resourceId: item.id, result: "success", after: item });
    return NextResponse.json({ item: decode(item) }, { status: 201 });
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    console.error("views:create", error);
    return NextResponse.json({ error: "Création de vue impossible." }, { status: 503 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const permission = await requirePermission(actor, "saved_view", "update");
    const body = await request.json() as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id : "";
    const expectedVersion = Number(body.version);
    if (!id || !Number.isInteger(expectedVersion) || expectedVersion < 1) return NextResponse.json({ error: "Version de vue requise." }, { status: 400 });
    const db = getDb();
    const current = (await db.select().from(savedViews).where(and(eq(savedViews.id, id), eq(savedViews.tenantId, actor.tenantId))).limit(1))[0];
    if (!current || !canAccess(actor, permission, current)) return NextResponse.json({ error: "Vue introuvable." }, { status: 404 });
    if (current.version !== expectedVersion) return NextResponse.json({ error: "La vue a été modifiée par un autre utilisateur." }, { status: 409 });
    const input = validate({ name: current.name, objectType: current.objectType, isDefault: current.isDefault === 1, ...body, scope: body.scope ?? current.scope, definition: body.definition ?? JSON.parse(current.definition) });
    if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });
    if (!canPublish(permission, input.scope)) return NextResponse.json({ error: "Partage non autorisé." }, { status: 403 });
    if (input.isDefault) await clearDefault(db, actor.tenantId, actor.userId, input.objectType);
    const item = (await db.update(savedViews).set({ name: input.name, definition: JSON.stringify(input.definition), scope: input.scope, teamId: input.scope === "team" ? actor.teamId : null, isDefault: input.isDefault ? 1 : 0, version: current.version + 1, updatedAt: new Date().toISOString() }).where(and(eq(savedViews.id, id), eq(savedViews.tenantId, actor.tenantId), eq(savedViews.version, expectedVersion))).returning())[0];
    if (!item) return NextResponse.json({ error: "Conflit de mise à jour." }, { status: 409 });
    await audit(actor, { action: "saved_view.updated", resourceType: "saved_view", resourceId: id, result: "success", before: current, after: item });
    return NextResponse.json({ item: decode(item) });
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    console.error("views:update", error);
    return NextResponse.json({ error: "Mise à jour de vue impossible." }, { status: 503 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const permission = await requirePermission(actor, "saved_view", "delete");
    const id = request.nextUrl.searchParams.get("id") ?? "";
    const db = getDb();
    const current = (await db.select().from(savedViews).where(and(eq(savedViews.id, id), eq(savedViews.tenantId, actor.tenantId))).limit(1))[0];
    if (!current || !canAccess(actor, permission, current)) return NextResponse.json({ error: "Vue introuvable." }, { status: 404 });
    const item = (await db.update(savedViews).set({ status: "archived", version: current.version + 1, updatedAt: new Date().toISOString() }).where(and(eq(savedViews.id, id), eq(savedViews.tenantId, actor.tenantId), eq(savedViews.version, current.version))).returning())[0];
    if (!item) return NextResponse.json({ error: "Conflit de suppression." }, { status: 409 });
    await audit(actor, { action: "saved_view.archived", resourceType: "saved_view", resourceId: id, result: "success", before: current, after: item });
    return NextResponse.json({ item: decode(item) });
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    console.error("views:archive", error);
    return NextResponse.json({ error: "Suppression de vue impossible." }, { status: 503 });
  }
}

function validate(body: Record<string, unknown>): { ok: true; name: string; objectType: string; scope: string; definition: Record<string, unknown>; isDefault: boolean } | { ok: false; error: string } {
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
  const objectType = typeof body.objectType === "string" ? body.objectType.trim().toLowerCase() : "";
  const scope = typeof body.scope === "string" ? body.scope : "personal";
  const definition = body.definition && typeof body.definition === "object" && !Array.isArray(body.definition) ? body.definition as Record<string, unknown> : null;
  if (!name || !/^[a-z][a-z0-9_]{0,49}$/.test(objectType) || !SCOPES.has(scope) || !definition || JSON.stringify(definition).length > 32768) return { ok: false, error: "Vue invalide." };
  return { ok: true, name, objectType, scope, definition, isDefault: body.isDefault === true };
}

function canPublish(permission: PermissionScope, scope: string) { return scope === "personal" || permission === "tenant" || (scope === "team" && permission === "team"); }
function canAccess(actor: { userId: string; teamId: string }, permission: PermissionScope, row: { ownerId: string; teamId: string | null; scope: string }) {
  if (row.ownerId === actor.userId) return true;
  if (permission === "personal") return false;
  if (row.scope === "tenant") return permission === "tenant";
  return row.scope === "team" && row.teamId === actor.teamId;
}
function decode<T extends { definition: string; isDefault: number }>(row: T) { return { ...row, definition: JSON.parse(row.definition) as Record<string, unknown>, isDefault: row.isDefault === 1 }; }
async function clearDefault(db: ReturnType<typeof getDb>, tenantId: string, userId: string, objectType: string) { await db.update(savedViews).set({ isDefault: 0, updatedAt: new Date().toISOString() }).where(and(eq(savedViews.tenantId, tenantId), eq(savedViews.ownerId, userId), eq(savedViews.objectType, objectType), eq(savedViews.isDefault, 1))); }

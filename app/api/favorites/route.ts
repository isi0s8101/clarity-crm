import { and, desc, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/db";
import { favorites } from "@/db/schema";
import { audit, authErrorResponse, requirePermission, resolveAuthContext } from "@/lib/authz";
import { crmErrorResponse, getCrmRecord } from "@/lib/crm-core";
import { assertSameOriginMutation } from "@/lib/native-auth";

const RESOURCE_TYPE = "crm_record";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "favorite", "read");
    const items = await getDb().select().from(favorites).where(and(
      eq(favorites.tenantId, actor.tenantId), eq(favorites.userId, actor.userId),
    )).orderBy(desc(favorites.createdAt)).limit(200);
    return NextResponse.json({ items });
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    console.error("favorites:list", error);
    return NextResponse.json({ error: "Favoris indisponibles." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "favorite", "create");
    const body = await request.json() as Record<string, unknown>;
    const resourceType = typeof body.resourceType === "string" ? body.resourceType : "";
    const resourceId = typeof body.resourceId === "string" ? body.resourceId : "";
    if (resourceType !== RESOURCE_TYPE || !resourceId) return NextResponse.json({ error: "Ressource favorite invalide." }, { status: 400 });
    await getCrmRecord(actor, resourceId, "read");
    const db = getDb();
    const existing = (await db.select().from(favorites).where(and(
      eq(favorites.tenantId, actor.tenantId), eq(favorites.userId, actor.userId), eq(favorites.resourceType, resourceType), eq(favorites.resourceId, resourceId),
    )).limit(1))[0];
    if (existing) return NextResponse.json({ item: existing });
    const item = (await db.insert(favorites).values({ id: crypto.randomUUID(), tenantId: actor.tenantId, userId: actor.userId, resourceType, resourceId }).returning())[0];
    await audit(actor, { action: "favorite.created", resourceType: "favorite", resourceId: item.id, result: "success", after: item });
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    console.error("favorites:create", error);
    return NextResponse.json({ error: "Ajout du favori impossible." }, { status: 503 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "favorite", "delete");
    const id = request.nextUrl.searchParams.get("id") ?? "";
    const item = (await getDb().delete(favorites).where(and(
      eq(favorites.id, id), eq(favorites.tenantId, actor.tenantId), eq(favorites.userId, actor.userId),
    )).returning())[0];
    if (!item) return NextResponse.json({ error: "Favori introuvable." }, { status: 404 });
    await audit(actor, { action: "favorite.deleted", resourceType: "favorite", resourceId: id, result: "success", before: item });
    return NextResponse.json({ item });
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    console.error("favorites:delete", error);
    return NextResponse.json({ error: "Suppression du favori impossible." }, { status: 503 });
  }
}

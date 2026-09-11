import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { crmNotifications } from "@/db/schema";
import { audit, authErrorResponse, resolveAuthContext } from "@/lib/authz";
import { listNotifications, unreadNotificationCount } from "@/lib/notifications";
import { assertSameOriginMutation } from "@/lib/native-auth";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    const [items, unread] = await Promise.all([listNotifications(actor), unreadNotificationCount(actor)]);
    return NextResponse.json({ items, unread });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("notifications:list", error);
    return NextResponse.json({ error: "Notifications indisponibles." }, { status: 503 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const body = await request.json() as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id : "";
    const markAll = body.markAll === true;
    if (!id && !markAll) return NextResponse.json({ error: "Notification invalide." }, { status: 400 });
    const now = new Date().toISOString();
    const conditions = [eq(crmNotifications.tenantId, actor.tenantId), eq(crmNotifications.recipientId, actor.userId)];
    if (id) conditions.push(eq(crmNotifications.id, id));
    const updated = await getDb().update(crmNotifications).set({ readAt: now }).where(and(...conditions)).returning();
    if (id && !updated[0]) return NextResponse.json({ error: "Notification introuvable." }, { status: 404 });
    await audit(actor, { action: "notification.read", resourceType: "notification", resourceId: id || "all", result: "success", details: { count: updated.length } });
    return NextResponse.json({ items: updated });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("notifications:read", error);
    return NextResponse.json({ error: "Mise à jour impossible." }, { status: 503 });
  }
}

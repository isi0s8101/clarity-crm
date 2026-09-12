import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/db";
import { userPreferences } from "@/db/schema";
import { audit, authErrorResponse, requirePermission, resolveAuthContext } from "@/lib/authz";
import { assertSameOriginMutation } from "@/lib/native-auth";

const ALLOWED = new Set(["homePage", "defaultViewId", "defaultDashboardId", "pageSize", "density", "timeZone", "dateFormat", "notifications", "navigation", "locale"]);

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "user_preference", "read");
    const row = (await getDb().select().from(userPreferences).where(and(eq(userPreferences.tenantId, actor.tenantId), eq(userPreferences.userId, actor.userId))).limit(1))[0];
    return NextResponse.json({ item: row ? decode(row) : { settings: {}, version: 0 } });
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    console.error("preferences:get", error);
    return NextResponse.json({ error: "Préférences indisponibles." }, { status: 503 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "user_preference", "update");
    const body = await request.json() as Record<string, unknown>;
    const settings = validate(body.settings);
    if (!settings) return NextResponse.json({ error: "Préférences invalides." }, { status: 400 });
    const version = Number(body.version);
    const db = getDb();
    const current = (await db.select().from(userPreferences).where(and(eq(userPreferences.tenantId, actor.tenantId), eq(userPreferences.userId, actor.userId))).limit(1))[0];
    if (current && (!Number.isInteger(version) || version !== current.version)) return NextResponse.json({ error: "Les préférences ont été modifiées par une autre session." }, { status: 409 });
    const item = current
      ? (await db.update(userPreferences).set({ settings: JSON.stringify(settings), version: current.version + 1, updatedAt: new Date().toISOString() }).where(and(eq(userPreferences.tenantId, actor.tenantId), eq(userPreferences.userId, actor.userId), eq(userPreferences.version, current.version))).returning())[0]
      : (await db.insert(userPreferences).values({ tenantId: actor.tenantId, userId: actor.userId, settings: JSON.stringify(settings) }).returning())[0];
    if (!item) return NextResponse.json({ error: "Conflit de mise à jour." }, { status: 409 });
    await audit(actor, { action: "user_preferences.updated", resourceType: "user_preference", resourceId: actor.userId, result: "success", before: current ? decode(current) : {}, after: decode(item) });
    return NextResponse.json({ item: decode(item) });
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    console.error("preferences:update", error);
    return NextResponse.json({ error: "Mise à jour des préférences impossible." }, { status: 503 });
  }
}

function validate(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const settings: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!ALLOWED.has(key)) return null;
    if (typeof item === "string" && item.length <= 120) settings[key] = item;
    else if (typeof item === "boolean") settings[key] = item;
    else if (typeof item === "number" && Number.isInteger(item) && item >= 10 && item <= 200) settings[key] = item;
    else if (key === "notifications" && item && typeof item === "object" && !Array.isArray(item) && JSON.stringify(item).length <= 4096) settings[key] = item;
    else return null;
  }
  return settings;
}
function decode<T extends { settings: string }>(row: T) { return { ...row, settings: JSON.parse(row.settings) as Record<string, unknown> }; }

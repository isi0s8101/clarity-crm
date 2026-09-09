import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { auditEvents } from "@/db/schema";
import {
  authErrorResponse,
  requirePermission,
  resolveAuthContext,
} from "@/lib/authz";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    const scope = await requirePermission(actor, "audit", "read");
    const params = request.nextUrl.searchParams;
    const result = params.get("result");
    const resourceType = params.get("resourceType");
    const db = getDb();

    const filters = [eq(auditEvents.tenantId, actor.tenantId)];
    if (scope === "team") {
      filters.push(eq(auditEvents.teamId, actor.teamId));
    } else if (scope === "personal") {
      filters.push(eq(auditEvents.actorId, actor.userId));
    }
    if (result && ["success", "denied", "failure"].includes(result)) {
      filters.push(eq(auditEvents.result, result));
    }
    if (resourceType) {
      filters.push(eq(auditEvents.resourceType, resourceType.slice(0, 50)));
    }

    const rows = await db
      .select()
      .from(auditEvents)
      .where(and(...filters))
      .orderBy(desc(auditEvents.createdAt))
      .limit(100);

    return NextResponse.json({ items: rows });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("audit:list", error);
    return NextResponse.json({ error: "Audit indisponible." }, { status: 503 });
  }
}

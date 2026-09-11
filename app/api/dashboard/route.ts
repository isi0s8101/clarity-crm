import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { crmTimelineEvents } from "@/db/schema";
import { authErrorResponse, canUseResource, requirePermission, resolveAuthContext } from "@/lib/authz";
import { crmErrorResponse, listCrmRecords } from "@/lib/crm-core";
import { summarizeDashboardRecords } from "@/lib/dashboard-metrics.js";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    const [opportunities, tasks] = await Promise.all([
      listCrmRecords(actor, { type: "opportunity", limit: 100, offset: 0 }),
      listCrmRecords(actor, { type: "task", limit: 100, offset: 0 }),
    ]);
    const metrics = summarizeDashboardRecords({ opportunities, tasks });

    let activity: Array<typeof crmTimelineEvents.$inferSelect> = [];
    try {
      const scope = await requirePermission(actor, "timeline", "read");
      const rows = await getDb()
        .select()
        .from(crmTimelineEvents)
        .where(eq(crmTimelineEvents.tenantId, actor.tenantId))
        .orderBy(desc(crmTimelineEvents.createdAt))
        .limit(100);
      activity = rows.filter((item) => canUseResource(actor, scope, item)).slice(0, 20);
    } catch {
      // L'absence de permission timeline ne doit pas rendre les KPI accessibles indisponibles.
    }

    return NextResponse.json({ ...metrics, activity });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    console.error("dashboard:get", error);
    return NextResponse.json({ error: "Dashboard indisponible." }, { status: 503 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { crmTimelineEvents } from "@/db/schema";
import {
  audit,
  authErrorResponse,
  canUseResource,
  requirePermission,
  resolveAuthContext,
} from "@/lib/authz";
import {
  appendTimeline,
  crmErrorResponse,
  getCrmRecord,
} from "@/lib/crm-core";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    const recordId = request.nextUrl.searchParams.get("recordId") ?? "";
    const record = await getCrmRecord(actor, recordId, "read");
    const scope = await requirePermission(actor, "timeline", "read");
    if (!canUseResource(actor, scope, record)) {
      return NextResponse.json({ items: [] });
    }

    const db = getDb();
    const items = await db
      .select()
      .from(crmTimelineEvents)
      .where(
        and(
          eq(crmTimelineEvents.tenantId, actor.tenantId),
          eq(crmTimelineEvents.recordId, recordId),
        ),
      )
      .orderBy(desc(crmTimelineEvents.createdAt))
      .limit(200);
    return NextResponse.json({ items });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    console.error("crm:timeline:list", error);
    return NextResponse.json({ error: "Timeline indisponible." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    const scope = await requirePermission(actor, "timeline", "create");
    const body = (await request.json()) as Record<string, unknown>;
    const recordId = typeof body.recordId === "string" ? body.recordId : "";
    const record = await getCrmRecord(actor, recordId, "read");
    if (!canUseResource(actor, scope, record)) {
      return NextResponse.json({ error: "Enregistrement introuvable." }, { status: 404 });
    }
    const summary = typeof body.summary === "string" ? body.summary.trim().slice(0, 240) : "";
    const eventType = typeof body.eventType === "string"
      ? body.eventType.trim().toLowerCase().slice(0, 80)
      : "manual.note";
    if (!summary || !/^[a-z][a-z0-9_.:-]{0,79}$/.test(eventType)) {
      return NextResponse.json({ error: "Événement invalide." }, { status: 400 });
    }
    const data = body.data && typeof body.data === "object" && !Array.isArray(body.data)
      ? (body.data as Record<string, unknown>)
      : {};
    if (JSON.stringify(data).length > 32768) {
      return NextResponse.json({ error: "Événement trop volumineux." }, { status: 400 });
    }
    await appendTimeline(actor, record, eventType, summary, data);
    await audit(actor, {
      action: "timeline.created",
      resourceType: record.type,
      resourceId: record.id,
      result: "success",
      details: { eventType, summary },
    });
    return NextResponse.json({ created: true }, { status: 201 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    console.error("crm:timeline:create", error);
    return NextResponse.json({ error: "Création de timeline impossible." }, { status: 503 });
  }
}

import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, requirePermission, resolveAuthContext } from "@/lib/authz";
import { crmErrorResponse, listCrmRecords } from "@/lib/crm-core";

const TYPES = ["task", "appointment", "intervention", "project", "worksite"] as const;

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "planning", "read");
    const groups = await Promise.all(TYPES.map(async (type) => {
      try { return await listCrmRecords(actor, { type, limit: 100 }); }
      catch { return []; }
    }));
    const items = groups.flatMap((records, index) => records.map((record) => toPlanningItem(record, TYPES[index])).filter(Boolean));
    items.sort((a, b) => String(a?.start ?? "").localeCompare(String(b?.start ?? "")));
    return NextResponse.json({ items });
  } catch (error) {
    const authResponse = authErrorResponse(error); if (authResponse) return authResponse;
    const crmResponse = crmErrorResponse(error); if (crmResponse) return crmResponse;
    console.error("planning:list", error);
    return NextResponse.json({ error: "Planning indisponible." }, { status: 503 });
  }
}

function toPlanningItem(record: Awaited<ReturnType<typeof listCrmRecords>>[number], type: string) {
  const data = record.data;
  let start: unknown;
  let end: unknown;
  if (type === "task") start = data.dueAt;
  if (type === "appointment") { start = data.startsAt; end = data.endsAt; }
  if (type === "intervention") { start = data.scheduled_at; end = data.ends_at; }
  if (type === "project" || type === "worksite") { start = data.start_date; end = data.end_date; }
  if (typeof start !== "string" || !start) return null;
  return { id: record.id, type, title: record.title, status: record.status, start, end: typeof end === "string" ? end : null, teamId: record.teamId, ownerId: record.ownerId };
}

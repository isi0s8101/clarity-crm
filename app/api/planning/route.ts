import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, requirePermission, resolveAuthContext } from "@/lib/authz";
import { crmErrorResponse, listCrmRecords } from "@/lib/crm-core";
import { assertSameOriginMutation } from "@/lib/native-auth";
import {
  bookAppointment,
  cancelAppointment,
  getAvailabilitySlots,
  listPlanningReservations,
  readJsonBodyLimited,
  rescheduleAppointment,
  v12ErrorResponse,
} from "@/lib/v12-planning";

const TYPES = ["task", "appointment", "intervention", "project", "worksite"] as const;

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "planning", "read");
    const mode = request.nextUrl.searchParams.get("mode") ?? "calendar";

    if (mode === "availability") {
      const result = await getAvailabilitySlots(actor, {
        resourceKind: request.nextUrl.searchParams.get("resourceKind"),
        resourceId: request.nextUrl.searchParams.get("resourceId"),
        from: request.nextUrl.searchParams.get("from") ?? "",
        to: request.nextUrl.searchParams.get("to") ?? "",
        durationMinutes: optionalInteger(request.nextUrl.searchParams.get("durationMinutes")),
      });
      return NextResponse.json(result);
    }

    if (mode === "reservations") {
      const items = await listPlanningReservations(actor, {
        from: request.nextUrl.searchParams.get("from"),
        to: request.nextUrl.searchParams.get("to"),
        resourceKind: request.nextUrl.searchParams.get("resourceKind"),
        resourceId: request.nextUrl.searchParams.get("resourceId"),
      });
      return NextResponse.json({ items });
    }

    const groups = await Promise.all(TYPES.map(async (type) => {
      try { return await listCrmRecords(actor, { type, limit: 100 }); }
      catch { return []; }
    }));
    const items = groups.flatMap((records, index) => records.map((record) => toPlanningItem(record, TYPES[index])).filter(Boolean));
    items.sort((a, b) => String(a?.start ?? "").localeCompare(String(b?.start ?? "")));
    return NextResponse.json({ items });
  } catch (error) {
    return planningError(error, "planning:list");
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const body = await readJsonBodyLimited(request);
    const item = await bookAppointment(actor, {
      title: stringValue(body.title),
      startsAt: stringValue(body.startsAt),
      endsAt: stringValue(body.endsAt),
      timezone: optionalString(body.timezone),
      resourceKind: optionalString(body.resourceKind),
      resourceId: optionalString(body.resourceId),
      bufferBeforeMinutes: optionalNumber(body.bufferBeforeMinutes),
      bufferAfterMinutes: optionalNumber(body.bufferAfterMinutes),
      idempotencyKey: stringValue(body.idempotencyKey),
      data: objectValue(body.data),
    });
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return planningError(error, "planning:book");
  }
}

export async function PATCH(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const body = await readJsonBodyLimited(request);
    const item = await rescheduleAppointment(actor, {
      appointmentId: stringValue(body.appointmentId),
      startsAt: stringValue(body.startsAt),
      endsAt: stringValue(body.endsAt),
      timezone: optionalString(body.timezone),
    });
    return NextResponse.json({ item });
  } catch (error) {
    return planningError(error, "planning:reschedule");
  }
}

export async function DELETE(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const body = await readJsonBodyLimited(request);
    const item = await cancelAppointment(actor, stringValue(body.appointmentId));
    return NextResponse.json({ item });
  } catch (error) {
    return planningError(error, "planning:cancel");
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

function planningError(error: unknown, label: string) {
  const authResponse = authErrorResponse(error); if (authResponse) return authResponse;
  const crmResponse = crmErrorResponse(error); if (crmResponse) return crmResponse;
  const v12Response = v12ErrorResponse(error); if (v12Response) return v12Response;
  console.error(label, error);
  return NextResponse.json({ error: "Planning indisponible." }, { status: 503 });
}

function optionalInteger(value: string | null) {
  if (!value) return undefined;
  const number = Number(value);
  return Number.isInteger(number) ? number : undefined;
}
function stringValue(value: unknown) { return typeof value === "string" ? value : ""; }
function optionalString(value: unknown) { return typeof value === "string" ? value : undefined; }
function optionalNumber(value: unknown) { return typeof value === "number" ? value : undefined; }
function objectValue(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }

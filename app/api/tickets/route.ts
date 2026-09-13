import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, resolveAuthContext } from "@/lib/authz";
import { crmErrorResponse } from "@/lib/crm-core";
import { assertSameOriginMutation } from "@/lib/native-auth";
import { createTicket, listTickets, TicketingError, updateTicket } from "@/lib/v11-ticketing";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    const items = await listTickets(actor, {
      status: request.nextUrl.searchParams.get("status"),
      q: request.nextUrl.searchParams.get("q"),
      limit: Number(request.nextUrl.searchParams.get("limit") || 50),
      offset: Number(request.nextUrl.searchParams.get("offset") || 0),
    });
    return NextResponse.json({ items });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    console.error("tickets:list", error);
    return NextResponse.json({ error: "Tickets indisponibles." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const body = await request.json() as Record<string, unknown>;
    const item = await createTicket(actor, {
      title: String(body.title ?? ""), description: String(body.description ?? ""),
      priority: typeof body.priority === "string" ? body.priority : undefined,
      category: typeof body.category === "string" ? body.category : undefined,
      requesterUserId: typeof body.requesterUserId === "string" ? body.requesterUserId : undefined,
      requesterEmail: typeof body.requesterEmail === "string" ? body.requesterEmail : undefined,
      assignedToUserId: typeof body.assignedToUserId === "string" ? body.assignedToUserId : undefined,
    });
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    if (error instanceof TicketingError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Corps JSON invalide." }, { status: 400 });
    console.error("tickets:create", error);
    return NextResponse.json({ error: "Création du ticket impossible." }, { status: 503 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const body = await request.json() as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id : "";
    const item = await updateTicket(actor, id, body);
    return NextResponse.json({ item });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    if (error instanceof TicketingError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Corps JSON invalide." }, { status: 400 });
    console.error("tickets:update", error);
    return NextResponse.json({ error: "Mise à jour du ticket impossible." }, { status: 503 });
  }
}

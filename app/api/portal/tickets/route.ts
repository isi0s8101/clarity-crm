import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, requirePermission, resolveAuthContext } from "@/lib/authz";
import { assertSameOriginMutation } from "@/lib/native-auth";
import { createPortalTicket, getPortalTicket, listPortalTickets, TicketingError, updatePortalTicket } from "@/lib/v11-ticketing";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "portal", "read");
    const id = request.nextUrl.searchParams.get("id") ?? "";
    if (id) return NextResponse.json({ item: await getPortalTicket(actor, id) });
    return NextResponse.json({ items: await listPortalTickets(actor) });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof TicketingError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("portal:tickets:list", error);
    return NextResponse.json({ error: "Portail tickets indisponible." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "portal", "create");
    const body = await request.json() as Record<string, unknown>;
    const item = await createPortalTicket(actor, {
      title: String(body.title ?? ""),
      description: String(body.description ?? ""),
      priority: typeof body.priority === "string" ? body.priority : undefined,
      category: typeof body.category === "string" ? body.category : undefined,
    });
    return NextResponse.json({ item: await getPortalTicket(actor, item.id) }, { status: 201 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof TicketingError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Corps JSON invalide." }, { status: 400 });
    console.error("portal:tickets:create", error);
    return NextResponse.json({ error: "Création du ticket impossible." }, { status: 503 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "portal", "update");
    const body = await request.json() as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id : "";
    const item = await updatePortalTicket(actor, id, body);
    return NextResponse.json({ item });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof TicketingError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Corps JSON invalide." }, { status: 400 });
    console.error("portal:tickets:update", error);
    return NextResponse.json({ error: "Mise à jour du ticket impossible." }, { status: 503 });
  }
}

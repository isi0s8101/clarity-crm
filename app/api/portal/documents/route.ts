import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/db";
import { audit, authErrorResponse, requirePermission, resolveAuthContext } from "@/lib/authz";
import { assertSameOriginMutation } from "@/lib/native-auth";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "portal", "read");
    if (actor.role !== "client") return NextResponse.json({ error: "Accès portail client requis." }, { status: 403 });
    const ticketId = request.nextUrl.searchParams.get("ticketId") ?? "";
    if (!/^[A-Za-z0-9._:-]{1,100}$/.test(ticketId)) return NextResponse.json({ error: "Ticket introuvable." }, { status: 404 });
    const result = await getPool().query(
      `SELECT d.id, d.original_name AS "originalName", d.mime_type AS "mimeType", d.size_bytes AS "sizeBytes", d.created_at AS "createdAt"
         FROM crm_documents d JOIN crm_records r ON r.tenant_id=d.tenant_id AND r.id=d.record_id
        WHERE d.tenant_id=$1 AND d.record_id=$2 AND d.status='active' AND d.portal_visible=1
          AND r.type='ticket' AND r.data::jsonb ->> 'requester_user_id'=$3
        ORDER BY d.created_at DESC`,
      [actor.tenantId, ticketId, actor.userId],
    );
    return NextResponse.json({ items: result.rows });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("portal:documents:list", error);
    return NextResponse.json({ error: "Documents portail indisponibles." }, { status: 503 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "portal", "administer");
    const body = await request.json() as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id : "";
    const visible = body.visible === true;
    if (!/^[A-Za-z0-9._:-]{1,100}$/.test(id)) return NextResponse.json({ error: "Document invalide." }, { status: 400 });
    const before = await getPool().query(
      `SELECT d.id, d.record_id, d.portal_visible
         FROM crm_documents d JOIN crm_records r ON r.tenant_id=d.tenant_id AND r.id=d.record_id
        WHERE d.tenant_id=$1 AND d.id=$2 AND d.status='active' AND r.type='ticket' LIMIT 1`,
      [actor.tenantId, id],
    );
    if (!before.rows[0]) return NextResponse.json({ error: "Document de ticket introuvable." }, { status: 404 });
    const updated = await getPool().query(
      "UPDATE crm_documents SET portal_visible=$1 WHERE tenant_id=$2 AND id=$3 RETURNING id, record_id AS \"recordId\", portal_visible AS \"portalVisible\"",
      [visible ? 1 : 0, actor.tenantId, id],
    );
    await audit(actor, {
      action: "portal.document.visibility.updated",
      resourceType: "document",
      resourceId: id,
      result: "success",
      before: before.rows[0],
      after: updated.rows[0],
    });
    return NextResponse.json({ item: updated.rows[0] });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Corps JSON invalide." }, { status: 400 });
    console.error("portal:documents:authorize", error);
    return NextResponse.json({ error: "Autorisation documentaire impossible." }, { status: 503 });
  }
}

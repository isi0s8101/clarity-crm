import { NextRequest } from "next/server";

import { getPool } from "@/db";
import { authErrorResponse, requirePermission, resolveAuthContext } from "@/lib/authz";
import { readStoredDocument } from "@/lib/documents";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "portal", "read");
    if (actor.role !== "client") return Response.json({ error: "Accès portail client requis." }, { status: 403 });
    const id = request.nextUrl.searchParams.get("id") ?? "";
    if (!/^[A-Za-z0-9._:-]{1,100}$/.test(id)) return Response.json({ error: "Document introuvable." }, { status: 404 });
    const result = await getPool().query(
      `SELECT d.storage_key, d.original_name, d.mime_type
         FROM crm_documents d JOIN crm_records r ON r.tenant_id=d.tenant_id AND r.id=d.record_id
        WHERE d.tenant_id=$1 AND d.id=$2 AND d.status='active' AND d.portal_visible=1
          AND r.type='ticket' AND r.data::jsonb ->> 'requester_user_id'=$3 LIMIT 1`,
      [actor.tenantId, id, actor.userId],
    );
    const document = result.rows[0];
    if (!document) return Response.json({ error: "Document introuvable." }, { status: 404 });
    const content = await readStoredDocument(document.storage_key);
    const fileName = String(document.original_name).replace(/["\\\r\n]/g, "-");
    return new Response(content, {
      headers: {
        "content-type": String(document.mime_type),
        "content-length": String(content.length),
        "content-disposition": `attachment; filename="${fileName}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("portal:documents:download", error);
    return Response.json({ error: "Téléchargement portail impossible." }, { status: 503 });
  }
}

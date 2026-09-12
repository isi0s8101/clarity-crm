import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { crmDocuments } from "@/db/schema";
import { audit, authErrorResponse, requireRecordPermission, resolveAuthContext } from "@/lib/authz";
import { crmErrorResponse, getCrmRecord } from "@/lib/crm-core";
import { readStoredDocument } from "@/lib/documents";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    const id = request.nextUrl.searchParams.get("id") ?? "";
    const rows = await getDb().select().from(crmDocuments).where(
      and(eq(crmDocuments.id, id), eq(crmDocuments.tenantId, actor.tenantId), eq(crmDocuments.status, "active")),
    ).limit(1);
    const document = rows[0];
    if (!document) return NextResponse.json({ error: "Document introuvable." }, { status: 404 });
    await getCrmRecord(actor, document.recordId, "read");
    await requireRecordPermission(actor, "document", "read");
    const content = await readStoredDocument(document.storageKey);
    await audit(actor, { action: "document.downloaded", resourceType: "document", resourceId: id, result: "success" });
    return new Response(content, {
      headers: {
        "content-type": document.mimeType,
        "content-length": String(content.length),
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(document.normalizedName)}`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    console.error("documents:download", error);
    return NextResponse.json({ error: "Téléchargement impossible." }, { status: 503 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { crmDocuments, crmDocumentVersions } from "@/db/schema";
import { audit, authErrorResponse, requireRecordPermission, resolveAuthContext } from "@/lib/authz";
import { crmErrorResponse, getCrmRecord } from "@/lib/crm-core";
import { discardStoredDocument, DocumentValidationError, storeDocument } from "@/lib/documents";
import { assertSameOriginMutation } from "@/lib/native-auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    const recordId = request.nextUrl.searchParams.get("recordId") ?? "";
    await getCrmRecord(actor, recordId, "read");
    await requireRecordPermission(actor, "document", "read");
    const items = await getDb().select().from(crmDocuments).where(
      and(eq(crmDocuments.tenantId, actor.tenantId), eq(crmDocuments.recordId, recordId), eq(crmDocuments.status, "active")),
    ).orderBy(desc(crmDocuments.createdAt)).limit(100);
    return NextResponse.json({ items });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    console.error("documents:list", error);
    return NextResponse.json({ error: "Documents indisponibles." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  let stored: Awaited<ReturnType<typeof storeDocument>> | null = null;
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const form = await request.formData();
    const recordId = typeof form.get("recordId") === "string" ? String(form.get("recordId")) : "";
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Fichier requis." }, { status: 400 });
    const metadata = documentMetadata(form);
    if (!metadata) return NextResponse.json({ error: "Métadonnées documentaires invalides." }, { status: 400 });
    const record = await getCrmRecord(actor, recordId, "update");
    await requireRecordPermission(actor, "document", "create");
    const storedDocument = await storeDocument(actor.tenantId, file);
    stored = storedDocument;
    const item = await getDb().transaction(async (tx) => {
      const document = (await tx.insert(crmDocuments).values({
        ...storedDocument, tenantId: actor.tenantId, recordId: record.id, uploadedBy: actor.userId, ownerId: actor.userId, ...metadata,
      }).returning())[0];
      await tx.insert(crmDocumentVersions).values({
        id: crypto.randomUUID(), tenantId: actor.tenantId, documentId: document.id, version: 1,
        storageKey: storedDocument.storageKey, originalName: storedDocument.originalName, normalizedName: storedDocument.normalizedName,
        mimeType: storedDocument.mimeType, sizeBytes: storedDocument.sizeBytes, sha256: storedDocument.sha256, addedBy: actor.userId,
      });
      return document;
    });
    await audit(actor, { action: "document.uploaded", resourceType: "document", resourceId: storedDocument.id, result: "success", after: item });
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    if (stored) await discardStoredDocument(stored.storageKey);
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof DocumentValidationError) return NextResponse.json({ error: error.message }, { status: error.status });
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    console.error("documents:upload", error);
    return NextResponse.json({ error: "Téléversement impossible." }, { status: 503 });
  }
}

function documentMetadata(form: FormData): { category: string; tags: string; description: string } | null {
  const category = typeof form.get("category") === "string" ? String(form.get("category")).trim().slice(0, 80) : "";
  const description = typeof form.get("description") === "string" ? String(form.get("description")).trim().slice(0, 2000) : "";
  const rawTags = typeof form.get("tags") === "string" ? String(form.get("tags")) : "";
  const tags = rawTags.split(",").map((value) => value.normalize("NFKC").trim().toLowerCase()).filter((value) => /^[a-z0-9][a-z0-9_-]{0,39}$/.test(value)).slice(0, 20);
  if (rawTags && tags.length !== rawTags.split(",").filter((value) => value.trim()).length) return null;
  return { category, tags: JSON.stringify([...new Set(tags)]), description };
}

export async function PATCH(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const body = await request.json() as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id : "";
    const rows = await getDb().select().from(crmDocuments).where(
      and(eq(crmDocuments.id, id), eq(crmDocuments.tenantId, actor.tenantId), eq(crmDocuments.status, "active")),
    ).limit(1);
    const document = rows[0];
    if (!document) return NextResponse.json({ error: "Document introuvable." }, { status: 404 });
    await getCrmRecord(actor, document.recordId, "update");
    await requireRecordPermission(actor, "document", "delete");
    const updated = await getDb().update(crmDocuments).set({ status: "archived", archivedAt: new Date().toISOString() }).where(
      and(eq(crmDocuments.id, id), eq(crmDocuments.tenantId, actor.tenantId)),
    ).returning();
    await audit(actor, { action: "document.archived", resourceType: "document", resourceId: id, result: "success", before: document, after: updated[0] });
    return NextResponse.json({ item: updated[0] });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    console.error("documents:archive", error);
    return NextResponse.json({ error: "Archivage impossible." }, { status: 503 });
  }
}

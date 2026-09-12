import { and, desc, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/db";
import { crmDocuments, crmDocumentVersions } from "@/db/schema";
import { audit, authErrorResponse, requireRecordPermission, resolveAuthContext } from "@/lib/authz";
import { crmErrorResponse, getCrmRecord } from "@/lib/crm-core";
import { discardStoredDocument, DocumentValidationError, storeDocument } from "@/lib/documents";
import { assertSameOriginMutation } from "@/lib/native-auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveAuthContext(request);
    const { id } = await params;
    const document = await findDocument(actor.tenantId, id);
    if (!document) return NextResponse.json({ error: "Document introuvable." }, { status: 404 });
    await getCrmRecord(actor, document.recordId, "read");
    await requireRecordPermission(actor, "document", "read");
    const items = await getDb().select().from(crmDocumentVersions).where(and(eq(crmDocumentVersions.tenantId, actor.tenantId), eq(crmDocumentVersions.documentId, id))).orderBy(desc(crmDocumentVersions.version)).limit(100);
    return NextResponse.json({ items });
  } catch (error) {
    const response = authErrorResponse(error);
    if (response) return response;
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    console.error("document:versions:list", error);
    return NextResponse.json({ error: "Versions documentaires indisponibles." }, { status: 503 });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let stored: Awaited<ReturnType<typeof storeDocument>> | null = null;
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const { id } = await params;
    const document = await findDocument(actor.tenantId, id);
    if (!document) return NextResponse.json({ error: "Document introuvable." }, { status: 404 });
    await getCrmRecord(actor, document.recordId, "update");
    await requireRecordPermission(actor, "document", "create");
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Fichier requis." }, { status: 400 });
    const storedDocument = await storeDocument(actor.tenantId, file);
    stored = storedDocument;
    const item = await getDb().transaction(async (tx) => {
      const current = (await tx.select().from(crmDocuments).where(and(eq(crmDocuments.id, id), eq(crmDocuments.tenantId, actor.tenantId), eq(crmDocuments.status, "active"))).limit(1))[0];
      if (!current || current.currentVersion !== document.currentVersion) throw new VersionConflictError();
      const version = current.currentVersion + 1;
      const versionItem = (await tx.insert(crmDocumentVersions).values({ id: crypto.randomUUID(), tenantId: actor.tenantId, documentId: id, version, storageKey: storedDocument.storageKey, originalName: storedDocument.originalName, normalizedName: storedDocument.normalizedName, mimeType: storedDocument.mimeType, sizeBytes: storedDocument.sizeBytes, sha256: storedDocument.sha256, addedBy: actor.userId }).returning())[0];
      const updated = await tx.update(crmDocuments).set({ storageKey: storedDocument.storageKey, originalName: storedDocument.originalName, normalizedName: storedDocument.normalizedName, mimeType: storedDocument.mimeType, sizeBytes: storedDocument.sizeBytes, sha256: storedDocument.sha256, uploadedBy: actor.userId, currentVersion: version }).where(and(eq(crmDocuments.id, id), eq(crmDocuments.tenantId, actor.tenantId), eq(crmDocuments.currentVersion, current.currentVersion))).returning({ id: crmDocuments.id });
      if (!updated[0]) throw new VersionConflictError();
      return versionItem;
    });
    await audit(actor, { action: "document.version_uploaded", resourceType: "document", resourceId: id, result: "success", before: { version: document.currentVersion }, after: item });
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    if (stored) await discardStoredDocument(stored.storageKey);
    if (error instanceof VersionConflictError) return NextResponse.json({ error: "Le document a été modifié par un autre utilisateur." }, { status: 409 });
    const response = authErrorResponse(error);
    if (response) return response;
    if (error instanceof DocumentValidationError) return NextResponse.json({ error: error.message }, { status: error.status });
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    console.error("document:versions:create", error);
    return NextResponse.json({ error: "Création de version impossible." }, { status: 503 });
  }
}

async function findDocument(tenantId: string, id: string) {
  return (await getDb().select().from(crmDocuments).where(and(eq(crmDocuments.id, id), eq(crmDocuments.tenantId, tenantId), eq(crmDocuments.status, "active"))).limit(1))[0];
}
class VersionConflictError extends Error {}

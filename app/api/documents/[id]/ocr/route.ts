import { and, desc, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/db";
import { crmDocuments, crmOcrJobs, crmOcrResults } from "@/db/schema";
import { audit, authErrorResponse, requireRecordPermission, resolveAuthContext } from "@/lib/authz";
import { crmErrorResponse, getCrmRecord } from "@/lib/crm-core";
import { assertSameOriginMutation } from "@/lib/native-auth";
import { assertOcrEligible, OcrValidationError, processOcrJob, validateOcrLanguage } from "@/lib/ocr";

export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveAuthContext(request);
    const document = await resolveDocument(actor, (await params).id, "read");
    const [jobs, results] = await Promise.all([
      getDb().select().from(crmOcrJobs).where(and(eq(crmOcrJobs.tenantId, actor.tenantId), eq(crmOcrJobs.documentId, document.id))).orderBy(desc(crmOcrJobs.createdAt)).limit(20),
      getDb().select().from(crmOcrResults).where(and(eq(crmOcrResults.tenantId, actor.tenantId), eq(crmOcrResults.documentId, document.id))).orderBy(desc(crmOcrResults.createdAt)).limit(20),
    ]);
    return NextResponse.json({ jobs, results });
  } catch (error) {
    return errorResponse(error, "Historique OCR indisponible.");
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const document = await resolveDocument(actor, (await params).id, "update");
    await requireRecordPermission(actor, "document", "create");
    assertOcrEligible(document);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const language = validateOcrLanguage(body.language ?? "eng");
    const existingCount = (await getDb().select({ id: crmOcrJobs.id }).from(crmOcrJobs).where(and(
      eq(crmOcrJobs.tenantId, actor.tenantId), eq(crmOcrJobs.documentId, document.id),
    )).limit(3)).length;
    if (existingCount >= 2) return NextResponse.json({ error: "Nombre maximal de tentatives OCR atteint." }, { status: 409 });
    const pending = (await getDb().insert(crmOcrJobs).values({
      id: crypto.randomUUID(), tenantId: actor.tenantId, documentId: document.id, requestedBy: actor.userId,
      language, correlationId: crypto.randomUUID(),
    }).returning())[0];
    await audit(actor, { action: "document.ocr_requested", resourceType: "document", resourceId: document.id, result: "success", after: { jobId: pending.id, language } });
    const outcome = await processOcrJob(pending.id);
    await audit(actor, { action: outcome.job.status === "completed" ? "document.ocr_completed" : "document.ocr_failed", resourceType: "document", resourceId: document.id, result: outcome.job.status === "completed" ? "success" : "failure", details: { jobId: pending.id, correlationId: pending.correlationId } });
    return NextResponse.json(outcome, { status: outcome.job.status === "completed" ? 201 : 422 });
  } catch (error) {
    return errorResponse(error, "OCR indisponible.");
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const document = await resolveDocument(actor, (await params).id, "update");
    await requireRecordPermission(actor, "document", "update");
    const body = await request.json() as Record<string, unknown>;
    const resultId = typeof body.resultId === "string" ? body.resultId : "";
    const correctedText = typeof body.correctedText === "string" ? body.correctedText.normalize("NFKC").slice(0, 1_000_000) : null;
    if (!resultId || correctedText === null) return NextResponse.json({ error: "Correction OCR invalide." }, { status: 400 });
    const updated = (await getDb().update(crmOcrResults).set({ correctedText, updatedAt: new Date().toISOString() }).where(and(
      eq(crmOcrResults.id, resultId), eq(crmOcrResults.tenantId, actor.tenantId), eq(crmOcrResults.documentId, document.id),
    )).returning())[0];
    if (!updated) return NextResponse.json({ error: "Résultat OCR introuvable." }, { status: 404 });
    await audit(actor, { action: "document.ocr_corrected", resourceType: "document", resourceId: document.id, result: "success", after: { resultId } });
    return NextResponse.json({ item: updated });
  } catch (error) {
    return errorResponse(error, "Correction OCR impossible.");
  }
}

async function resolveDocument(actor: Awaited<ReturnType<typeof resolveAuthContext>>, id: string, operation: "read" | "update") {
  const document = (await getDb().select().from(crmDocuments).where(and(eq(crmDocuments.id, id), eq(crmDocuments.tenantId, actor.tenantId), eq(crmDocuments.status, "active"))).limit(1))[0];
  if (!document) throw new OcrValidationError("Document introuvable.");
  await getCrmRecord(actor, document.recordId, operation);
  await requireRecordPermission(actor, "document", operation === "read" ? "read" : "update");
  return document;
}

function errorResponse(error: unknown, fallback: string) {
  const authResponse = authErrorResponse(error);
  if (authResponse) return authResponse;
  if (error instanceof OcrValidationError) return NextResponse.json({ error: error.message }, { status: error.status });
  const crmResponse = crmErrorResponse(error);
  if (crmResponse) return crmResponse;
  console.error("documents:ocr", error);
  return NextResponse.json({ error: fallback }, { status: 503 });
}

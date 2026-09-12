import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { crmDocuments, crmOcrJobs, crmOcrResults } from "@/db/schema";
import { storedDocumentPath } from "@/lib/documents";

const execFile = promisify(execFileCallback);
const OCR_MIME_TYPES = new Set(["image/jpeg", "image/png"]);
const OCR_LANGUAGES = new Set(["eng", "fra"]);
const MAX_OCR_TEXT_LENGTH = 1_000_000;
const OCR_TIMEOUT_MS = 25_000;

export class OcrValidationError extends Error {
  status = 400;
}

export function validateOcrLanguage(value: unknown) {
  if (typeof value !== "string" || !OCR_LANGUAGES.has(value)) {
    throw new OcrValidationError("Langue OCR non autorisée.");
  }
  return value as "eng" | "fra";
}

export function assertOcrEligible(document: { mimeType: string; sizeBytes: number }) {
  if (!OCR_MIME_TYPES.has(document.mimeType)) {
    throw new OcrValidationError("OCR disponible uniquement pour les images JPEG et PNG.");
  }
  if (!Number.isInteger(document.sizeBytes) || document.sizeBytes < 1 || document.sizeBytes > 10 * 1024 * 1024) {
    throw new OcrValidationError("Document OCR hors limites.");
  }
}

export async function processOcrJob(jobId: string) {
  const db = getDb();
  const claimed = await db.update(crmOcrJobs).set({
    status: "running",
    attempt: 1,
    startedAt: new Date().toISOString(),
    error: "",
  }).where(and(eq(crmOcrJobs.id, jobId), eq(crmOcrJobs.status, "pending"))).returning();
  const job = claimed[0];
  if (!job) throw new OcrValidationError("Job OCR indisponible.");

  try {
    const document = (await db.select().from(crmDocuments).where(and(
      eq(crmDocuments.id, job.documentId),
      eq(crmDocuments.tenantId, job.tenantId),
      eq(crmDocuments.status, "active"),
    )).limit(1))[0];
    if (!document) throw new OcrValidationError("Document OCR introuvable.");
    assertOcrEligible(document);

    const { stdout } = await execFile("tesseract", [storedDocumentPath(document.storageKey), "stdout", "-l", job.language], {
      timeout: OCR_TIMEOUT_MS,
      maxBuffer: MAX_OCR_TEXT_LENGTH + 16_384,
      windowsHide: true,
    });
    const extractedText = stdout.normalize("NFKC").slice(0, MAX_OCR_TEXT_LENGTH);
    const result = (await db.insert(crmOcrResults).values({
      id: crypto.randomUUID(), tenantId: job.tenantId, documentId: job.documentId, jobId: job.id,
      engine: "tesseract", extractedText, pageCount: 1,
    }).returning())[0];
    const completed = (await db.update(crmOcrJobs).set({ status: "completed", finishedAt: new Date().toISOString() })
      .where(and(eq(crmOcrJobs.id, job.id), eq(crmOcrJobs.status, "running"))).returning())[0];
    if (!completed) throw new Error("Finalisation OCR concurrente refusée.");
    return { job: completed, result };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1000) : "Erreur OCR inconnue.";
    const failed = (await db.update(crmOcrJobs).set({ status: "failed", error: message, finishedAt: new Date().toISOString() })
      .where(and(eq(crmOcrJobs.id, job.id), eq(crmOcrJobs.status, "running"))).returning())[0];
    return { job: failed ?? job, result: null };
  }
}

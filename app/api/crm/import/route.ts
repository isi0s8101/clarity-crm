import { and, desc, eq, inArray } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/db";
import { crmImportJobs, crmRecords } from "@/db/schema";
import { audit, authErrorResponse, canUseResource, requireRecordPermission, resolveAuthContext } from "@/lib/authz";
import { createCrmRecord, crmErrorResponse } from "@/lib/crm-core";
import { validateConfiguredRecordData } from "@/lib/crm-runtime-validation";
import { normalizeRecordType, validateRecordInput } from "@/lib/crm-policy.js";
import { CsvImportError, decodeUtf8Csv, normalizeMapping, parseCsv, rowsToRecords } from "@/lib/csv-import.js";
import { assertSameOriginMutation } from "@/lib/native-auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    const items = await getDb().select().from(crmImportJobs).where(
      and(eq(crmImportJobs.tenantId, actor.tenantId), eq(crmImportJobs.actorId, actor.userId)),
    ).orderBy(desc(crmImportJobs.createdAt)).limit(50);
    return NextResponse.json({ items: items.map((item) => ({ ...item, report: safeJson(item.report) })) });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("crm:import:list", error);
    return NextResponse.json({ error: "Historique d'import indisponible." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const form = await request.formData();
    const type = normalizeRecordType(form.get("type"));
    const file = form.get("file");
    const confirm = form.get("confirm") === "true";
    if (!type) throw new CsvImportError("Type d'objet CRM invalide.");
    if (!(file instanceof File)) throw new CsvImportError("Fichier CSV requis.");
    if (file.type && !["text/csv", "application/csv", "text/plain"].includes(file.type)) {
      throw new CsvImportError("Le fichier doit être un CSV.");
    }
    await requireRecordPermission(actor, type, "create");
    const rawMapping = parseMapping(form.get("mapping"));
    const { headers, rows } = parseCsv(decodeUtf8Csv(new Uint8Array(await file.arrayBuffer())));
    const mapping = normalizeMapping(headers, rawMapping);
    const mapped = rowsToRecords(headers, rows, mapping);
    const errors = [...mapped.errors];
    const candidates: Array<{ row: number; title: string; status: string; data: Record<string, unknown> }> = [];
    for (const candidate of mapped.records) {
      const validation = validateRecordInput({ type, title: candidate.title, status: candidate.status, data: candidate.data });
      if (!validation.ok) {
        errors.push({ row: candidate.row, error: validation.error }); continue;
      }
      try {
        await validateConfiguredRecordData(actor.tenantId, type, validation.value.data);
        candidates.push({ row: candidate.row, ...validation.value });
      } catch (error) {
        errors.push({ row: candidate.row, error: error instanceof Error ? error.message : "Validation de configuration impossible." });
      }
    }
    const duplicateTitles = await existingAccessibleTitles(actor, type, candidates.map((candidate) => candidate.title));
    const accepted = candidates.filter((candidate) => {
      if (!duplicateTitles.has(candidate.title.toLocaleLowerCase())) return true;
      errors.push({ row: candidate.row, error: "Doublon déjà présent dans les données accessibles." });
      return false;
    });
    const report = { mapping, errors: errors.slice(0, 200), preview: accepted.slice(0, 20).map(({ row, ...record }) => ({ row, ...record })) };
    if (!confirm) {
      return NextResponse.json({ dryRun: true, totalRows: rows.length, validRows: accepted.length, rejectedRows: errors.length, report });
    }

    let importedRows = 0;
    const executionErrors = [...errors];
    for (const candidate of accepted) {
      try {
        await createCrmRecord(actor, { type, title: candidate.title, status: candidate.status, data: candidate.data });
        importedRows += 1;
      } catch (error) {
        executionErrors.push({ row: candidate.row, error: error instanceof Error ? error.message : "Import impossible." });
      }
    }
    const status = executionErrors.length === 0 ? "completed" : importedRows > 0 ? "partial" : "rejected";
    const inserted = await getDb().insert(crmImportJobs).values({
      id: crypto.randomUUID(), tenantId: actor.tenantId, actorId: actor.userId, objectType: type, status,
      sourceName: safeSourceName(file.name), totalRows: rows.length, importedRows, rejectedRows: executionErrors.length,
      report: JSON.stringify({ ...report, errors: executionErrors.slice(0, 200) }),
    }).returning();
    await audit(actor, {
      action: "crm_import.completed", resourceType: type, resourceId: inserted[0].id, result: status === "completed" ? "success" : "failure",
      details: { totalRows: rows.length, importedRows, rejectedRows: executionErrors.length, dryRun: false },
    });
    return NextResponse.json({ dryRun: false, job: { ...inserted[0], report: safeJson(inserted[0].report) } }, { status: status === "completed" ? 201 : 207 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof CsvImportError) return NextResponse.json({ error: error.message }, { status: error.status });
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    console.error("crm:import", error);
    return NextResponse.json({ error: "Import CRM indisponible." }, { status: 503 });
  }
}

async function existingAccessibleTitles(actor: Awaited<ReturnType<typeof resolveAuthContext>>, type: string, titles: string[]) {
  const unique = [...new Set(titles)].slice(0, 5000);
  if (unique.length === 0) return new Set<string>();
  const scope = await requireRecordPermission(actor, type, "read");
  const rows = await getDb().select().from(crmRecords).where(and(
    eq(crmRecords.tenantId, actor.tenantId), eq(crmRecords.type, type), inArray(crmRecords.title, unique),
  ));
  return new Set(rows.filter((row) => canUseResource(actor, scope, row)).map((row) => row.title.toLocaleLowerCase()));
}

function parseMapping(value: FormDataEntryValue | null) {
  if (!value) return {};
  if (typeof value !== "string" || value.length > 20_000) throw new CsvImportError("Mapping CSV invalide.");
  try { return JSON.parse(value) as unknown; } catch { throw new CsvImportError("Mapping CSV invalide."); }
}

function safeSourceName(value: string) {
  return (value || "import.csv").replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 180) || "import.csv";
}

function safeJson(value: string) {
  try { return JSON.parse(value) as unknown; } catch { return {}; }
}

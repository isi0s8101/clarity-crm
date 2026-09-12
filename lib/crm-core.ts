import { and, desc, eq, inArray, like } from "drizzle-orm";

import { getDb } from "@/db";
import {
  crmRecords,
  crmTimelineEvents,
} from "@/db/schema";
import {
  audit,
  canUseResource,
  requireRecordPermission,
  type AuthContext,
} from "@/lib/authz";
import { runAutomations, type AutomationEvent } from "@/lib/automation";
import {
  extractKnownRecordRefs,
  normalizeRecordType,
  normalizeRecordStatus,
  validateRecordInput,
} from "@/lib/crm-policy.js";
import {
  CrmConfigurationValidationError,
  validateConfiguredRecordData,
} from "@/lib/crm-runtime-validation";
import { buildCrmFilterCondition } from "@/lib/crm-filters";
import { CrmFilterValidationError } from "@/lib/crm-filter-policy.js";
import type { CrmFilterGroup } from "@/lib/crm-filter-types";
import { dispatchOutboundWebhooks, type WebhookEvent } from "@/lib/webhooks";

export type CrmRecord = {
  id: string;
  tenantId: string;
  teamId: string;
  ownerId: string;
  type: string;
  title: string;
  data: Record<string, unknown>;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export class CrmValidationError extends Error {
  status = 400;
}

export class CrmNotFoundError extends Error {
  status = 404;
}

export async function listCrmRecords(
  actor: AuthContext,
  input: { type: string; status?: string | null; q?: string | null; filters?: CrmFilterGroup; limit?: number; offset?: number; action?: "read" | "export" },
) {
  const type = normalizeRecordType(input.type);
  if (!type) throw new CrmValidationError("Type CRM invalide.");
  const scope = await requireRecordPermission(actor, type, input.action ?? "read");
  const filters = [eq(crmRecords.tenantId, actor.tenantId), eq(crmRecords.type, type)];
  if (input.status) {
    const status = normalizeRecordStatus(input.status, null);
    if (!status) throw new CrmValidationError("Statut invalide.");
    filters.push(eq(crmRecords.status, status));
  }
  if (scope === "team") filters.push(eq(crmRecords.teamId, actor.teamId));
  if (scope === "personal") filters.push(eq(crmRecords.ownerId, actor.userId));
  if (input.q?.trim()) filters.push(like(crmRecords.title, `%${input.q.trim().slice(0, 80)}%`));
  if (input.filters) {
    const filterCondition = buildCrmFilterCondition(input.filters);
    if (!filterCondition) throw new CrmFilterValidationError("Filtres CRM invalides.");
    filters.push(filterCondition);
  }

  const limit = Math.min(100, Math.max(1, input.limit ?? 50));
  const offset = Math.min(10000, Math.max(0, input.offset ?? 0));
  const db = getDb();
  const rows = await db
    .select()
    .from(crmRecords)
    .where(and(...filters))
    .orderBy(desc(crmRecords.updatedAt))
    .limit(limit)
    .offset(offset);
  return rows.map(decodeRecord);
}

export async function getCrmRecord(actor: AuthContext, id: string, action: "read" | "update" | "delete" = "read") {
  if (!isRecordId(id)) throw new CrmValidationError("Identifiant CRM invalide.");
  const db = getDb();
  const rows = await db
    .select()
    .from(crmRecords)
    .where(and(eq(crmRecords.id, id), eq(crmRecords.tenantId, actor.tenantId)))
    .limit(1);
  if (!rows[0]) throw new CrmNotFoundError("Enregistrement introuvable.");
  const record = decodeRecord(rows[0]);
  const scope = await requireRecordPermission(actor, record.type, action);
  if (!canUseResource(actor, scope, record)) {
    throw new CrmNotFoundError("Enregistrement introuvable.");
  }
  return record;
}

export async function createCrmRecord(actor: AuthContext, input: Record<string, unknown>) {
  const validation = validateRecordInput(input);
  if (!validation.ok) throw new CrmValidationError(validation.error);
  const value = validation.value;
  await validateConfiguredRecordData(actor.tenantId, value.type, value.data);
  await requireRecordPermission(actor, value.type, "create");
  await assertReferencesBelongToTenant(actor.tenantId, value.data);

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const db = getDb();
  const inserted = await db
    .insert(crmRecords)
    .values({
      id,
      tenantId: actor.tenantId,
      teamId: actor.teamId,
      ownerId: actor.userId,
      type: value.type,
      title: value.title,
      data: JSON.stringify(value.data),
      status: value.status,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const record = decodeRecord(inserted[0]);

  await appendTimeline(actor, record, "record.created", `${record.title} créé`, { type: record.type });
  await audit(actor, {
    action: "crm_record.created",
    resourceType: record.type,
    resourceId: record.id,
    result: "success",
    after: record,
  });
  await runSideEffects(actor, "record.created", record);
  return record;
}

export async function updateCrmRecord(actor: AuthContext, id: string, patch: Record<string, unknown>) {
  const existing = await getCrmRecord(actor, id, "update");
  if (patch.type !== undefined && patch.type !== existing.type) {
    throw new CrmValidationError("Le type d'un enregistrement est immuable.");
  }
  const patchData = patch.data === undefined ? {} : patch.data;
  if (!patchData || typeof patchData !== "object" || Array.isArray(patchData)) {
    throw new CrmValidationError("Les données métier doivent être un objet JSON.");
  }
  const mergedData = {
    ...existing.data,
    ...(patchData as Record<string, unknown>),
  };
  const validation = validateRecordInput({
    type: existing.type,
    title: patch.title ?? existing.title,
    status: patch.status ?? existing.status,
    data: mergedData,
  });
  if (!validation.ok) throw new CrmValidationError(validation.error);
  await validateConfiguredRecordData(actor.tenantId, existing.type, validation.value.data);
  await assertReferencesBelongToTenant(actor.tenantId, validation.value.data);

  const db = getDb();
  const updated = await db
    .update(crmRecords)
    .set({
      title: validation.value.title,
      status: validation.value.status,
      data: JSON.stringify(validation.value.data),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(crmRecords.id, id), eq(crmRecords.tenantId, actor.tenantId)))
    .returning();
  if (!updated[0]) throw new CrmNotFoundError("Enregistrement introuvable.");
  const record = decodeRecord(updated[0]);

  await appendTimeline(actor, record, "record.updated", `${record.title} mis à jour`, {
    previousStatus: existing.status,
    status: record.status,
  });
  await audit(actor, {
    action: "crm_record.updated",
    resourceType: record.type,
    resourceId: record.id,
    result: "success",
    before: existing,
    after: record,
  });
  await runSideEffects(actor, "record.updated", record);
  if (record.status !== existing.status) {
    await runAutomations(actor, "record.status_changed", record);
  }
  if (record.data.stage !== existing.data.stage) {
    await runAutomations(actor, "record.pipeline_changed", record);
  }
  return record;
}

export async function archiveCrmRecord(actor: AuthContext, id: string) {
  const existing = await getCrmRecord(actor, id, "delete");
  if (existing.status === "archived") return existing;
  const db = getDb();
  const updated = await db
    .update(crmRecords)
    .set({ status: "archived", updatedAt: new Date().toISOString() })
    .where(and(eq(crmRecords.id, id), eq(crmRecords.tenantId, actor.tenantId)))
    .returning();
  const record = decodeRecord(updated[0]);
  await appendTimeline(actor, record, "record.archived", `${record.title} archivé`, {});
  await audit(actor, {
    action: "crm_record.archived",
    resourceType: record.type,
    resourceId: record.id,
    result: "success",
    before: existing,
    after: record,
  });
  await runSideEffects(actor, "record.archived", record);
  return record;
}

export async function appendTimeline(
  actor: AuthContext,
  record: CrmRecord,
  eventType: string,
  summary: string,
  data: Record<string, unknown>,
) {
  const db = getDb();
  await db.insert(crmTimelineEvents).values({
    tenantId: actor.tenantId,
    teamId: record.teamId,
    ownerId: record.ownerId,
    recordId: record.id,
    eventType: eventType.slice(0, 80),
    summary: summary.slice(0, 240),
    data: JSON.stringify(data),
    actorId: actor.userId,
  });
}

export function crmErrorResponse(error: unknown) {
  if (
    error instanceof CrmValidationError ||
    error instanceof CrmNotFoundError ||
    error instanceof CrmFilterValidationError ||
    error instanceof CrmConfigurationValidationError
  ) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  return null;
}

async function assertReferencesBelongToTenant(tenantId: string, data: Record<string, unknown>) {
  const references = extractKnownRecordRefs(data);
  if (references.length === 0) return;
  if (references.some((id: string) => !isRecordId(id))) {
    throw new CrmValidationError("Référence métier invalide.");
  }
  const db = getDb();
  const rows = await db
    .select({ id: crmRecords.id, tenantId: crmRecords.tenantId })
    .from(crmRecords)
    .where(inArray(crmRecords.id, references));
  if (rows.length !== references.length || rows.some((row) => row.tenantId !== tenantId)) {
    throw new CrmValidationError("Une référence métier est absente ou appartient à un autre tenant.");
  }
}

async function runSideEffects(actor: AuthContext, event: AutomationEvent & WebhookEvent, record: CrmRecord) {
  await Promise.allSettled([
    runAutomations(actor, event, record),
    dispatchOutboundWebhooks(actor, event, record),
  ]);
}

function decodeRecord(row: typeof crmRecords.$inferSelect): CrmRecord {
  let data: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.data) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    data = {};
  }
  return { ...row, data };
}

function isRecordId(value: string) {
  return typeof value === "string" && value.length >= 1 && value.length <= 100 && /^[A-Za-z0-9._:-]+$/.test(value);
}

import { getPool } from "@/db";
import { audit, type AuthContext } from "@/lib/authz";
import { enqueueAutomationJob } from "@/lib/automation-queue";
import { appendTimeline, createCrmRecord, getCrmRecord, listCrmRecords, updateCrmRecord, type CrmRecord } from "@/lib/crm-core";
import { createNotification } from "@/lib/notifications";

export class TicketingError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

type TicketInput = {
  title: string;
  description: string;
  priority?: string;
  category?: string;
  requesterUserId?: string;
  requesterEmail?: string;
  assignedToUserId?: string;
};

type SlaPolicy = { responseMinutes: number; resolutionMinutes: number; reminderMinutes: number };
const DEFAULT_SLA: SlaPolicy = { responseMinutes: 60, resolutionMinutes: 480, reminderMinutes: 30 };

export async function listTickets(actor: AuthContext, input: { status?: string | null; q?: string | null; limit?: number; offset?: number } = {}) {
  return listCrmRecords(actor, { type: "ticket", ...input });
}

export async function createTicket(actor: AuthContext, input: TicketInput, requesterOverride?: { userId: string; email: string }) {
  const title = text(input.title, 160);
  const description = text(input.description, 10000);
  const priority = ["low", "normal", "high", "urgent"].includes(String(input.priority)) ? String(input.priority) : "normal";
  const category = input.category === "sav" ? "sav" : "support";
  if (!title || !description) throw new TicketingError("Titre et description du ticket requis.");

  const requesterUserId = requesterOverride?.userId ?? text(input.requesterUserId, 100);
  const requesterEmail = requesterOverride?.email ?? text(input.requesterEmail, 254);
  const assignedToUserId = text(input.assignedToUserId, 100);
  if (requesterUserId) await assertActiveTenantMember(actor.tenantId, requesterUserId);
  if (assignedToUserId) await assertInternalTenantMember(actor.tenantId, assignedToUserId);

  const policy = await loadSlaPolicy(actor.tenantId);
  const now = Date.now();
  const responseMinutes = priority === "urgent" ? Math.max(1, Math.ceil(policy.responseMinutes / 2)) : policy.responseMinutes;
  const resolutionMinutes = priority === "urgent" ? Math.max(1, Math.ceil(policy.resolutionMinutes / 2)) : policy.resolutionMinutes;
  const pipelineKey = category === "sav" ? "ticket_sav" : "ticket_support";
  const stage = category === "sav" ? "received" : "open";

  return createCrmRecord(actor, {
    type: "ticket",
    title,
    status: "active",
    data: {
      priority,
      category,
      description,
      ...(requesterUserId ? { requester_user_id: requesterUserId } : {}),
      ...(requesterEmail ? { requester_email: requesterEmail } : {}),
      ...(assignedToUserId ? { assigned_to_user_id: assignedToUserId } : {}),
      response_due_at: new Date(now + responseMinutes * 60000).toISOString(),
      resolution_due_at: new Date(now + resolutionMinutes * 60000).toISOString(),
      sla_state: "within",
      pipelineKey,
      stage,
    },
  });
}

export async function updateTicket(actor: AuthContext, id: string, input: Record<string, unknown>) {
  const existing = await getCrmRecord(actor, id, "update");
  if (existing.type !== "ticket") throw new TicketingError("Le ticket est introuvable.", 404);
  const data: Record<string, unknown> = {};
  if (input.description !== undefined) {
    const description = text(input.description, 10000);
    if (!description) throw new TicketingError("Description invalide.");
    data.description = description;
  }
  if (input.priority !== undefined) {
    if (!["low", "normal", "high", "urgent"].includes(String(input.priority))) throw new TicketingError("Priorité invalide.");
    data.priority = input.priority;
  }
  if (input.assignedToUserId !== undefined) {
    const assignee = text(input.assignedToUserId, 100);
    if (assignee) await assertInternalTenantMember(actor.tenantId, assignee);
    data.assigned_to_user_id = assignee || undefined;
  }
  const action = typeof input.action === "string" ? input.action : "";
  if (action === "respond") {
    if (!existing.data.first_response_at) data.first_response_at = new Date().toISOString();
    if (existing.data.pipelineKey === "ticket_support" && existing.data.stage === "open") data.stage = "in_progress";
  } else if (action === "resolve") {
    data.resolved_at = new Date().toISOString();
    data.sla_state = existing.data.sla_state === "within" ? "within" : existing.data.sla_state;
    data.stage = existing.data.pipelineKey === "ticket_sav" ? "ready" : "resolved";
  } else if (action === "close") {
    data.stage = "closed";
  } else if (action && action !== "update") {
    throw new TicketingError("Action ticket invalide.");
  }
  return updateCrmRecord(actor, id, { data });
}

export async function createPortalTicket(actor: AuthContext, input: TicketInput) {
  if (actor.role !== "client") throw new TicketingError("Accès portail client requis.", 403);
  const serviceActor = await resolveInternalOwner(actor.tenantId);
  return createTicket(serviceActor, input, { userId: actor.userId, email: actor.email });
}

export async function listPortalTickets(actor: AuthContext) {
  if (actor.role !== "client") throw new TicketingError("Accès portail client requis.", 403);
  const result = await getPool().query(
    `SELECT id, title, status, data, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM crm_records
      WHERE tenant_id=$1 AND type='ticket' AND status <> 'archived'
        AND data::jsonb ->> 'requester_user_id' = $2
      ORDER BY updated_at DESC LIMIT 100`,
    [actor.tenantId, actor.userId],
  );
  return result.rows.map(publicTicket);
}

export async function getPortalTicket(actor: AuthContext, id: string) {
  if (actor.role !== "client") throw new TicketingError("Accès portail client requis.", 403);
  if (!recordId(id)) throw new TicketingError("Ticket introuvable.", 404);
  const result = await getPool().query(
    `SELECT id, title, status, data, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM crm_records
      WHERE tenant_id=$1 AND id=$2 AND type='ticket' AND status <> 'archived'
        AND data::jsonb ->> 'requester_user_id' = $3 LIMIT 1`,
    [actor.tenantId, id, actor.userId],
  );
  if (!result.rows[0]) throw new TicketingError("Ticket introuvable.", 404);
  return publicTicket(result.rows[0]);
}

export async function updatePortalTicket(actor: AuthContext, id: string, input: Record<string, unknown>) {
  await getPortalTicket(actor, id);
  const description = text(input.description, 10000);
  if (!description) throw new TicketingError("Description invalide.");
  const current = await getPool().query(
    "SELECT data FROM crm_records WHERE tenant_id=$1 AND id=$2 LIMIT 1",
    [actor.tenantId, id],
  );
  const data = parseData(current.rows[0]?.data);
  data.description = description;
  const updated = await getPool().query(
    `UPDATE crm_records SET data=$1, updated_at=CURRENT_TIMESTAMP
      WHERE tenant_id=$2 AND id=$3 AND type='ticket'
        AND data::jsonb ->> 'requester_user_id'=$4 RETURNING id`,
    [JSON.stringify(data), actor.tenantId, id, actor.userId],
  );
  if (!updated.rows[0]) throw new TicketingError("Ticket introuvable.", 404);
  const ticket = await getPortalTicket(actor, id);
  await audit(actor, { action: "portal.ticket.updated", resourceType: "ticket", resourceId: id, result: "success", details: { fields: ["description"] } });
  return ticket;
}

export async function processSlaDeadlines(limit = 50) {
  const result = await getPool().query(
    `SELECT id, tenant_id, team_id, owner_id, type, title, status, data, created_at, updated_at
       FROM crm_records
      WHERE type='ticket' AND status <> 'archived'
        AND (
          ((data::jsonb ->> 'response_due_at') IS NOT NULL AND (data::jsonb ->> 'first_response_at') IS NULL AND (data::jsonb ->> 'response_escalated_at') IS NULL AND (data::jsonb ->> 'response_due_at')::timestamptz <= CURRENT_TIMESTAMP)
          OR
          ((data::jsonb ->> 'resolution_due_at') IS NOT NULL AND (data::jsonb ->> 'resolved_at') IS NULL AND (data::jsonb ->> 'resolution_escalated_at') IS NULL AND (data::jsonb ->> 'resolution_due_at')::timestamptz <= CURRENT_TIMESTAMP)
        )
      ORDER BY updated_at LIMIT $1`,
    [Math.max(1, Math.min(200, limit))],
  );
  let processed = 0;
  for (const row of result.rows) {
    const data = parseData(row.data);
    const now = new Date().toISOString();
    const responseOverdue = !data.first_response_at && !data.response_escalated_at && due(data.response_due_at);
    const resolutionOverdue = !data.resolved_at && !data.resolution_escalated_at && due(data.resolution_due_at);
    if (!responseOverdue && !resolutionOverdue) continue;
    if (responseOverdue) data.response_escalated_at = now;
    if (resolutionOverdue) data.resolution_escalated_at = now;
    data.sla_state = responseOverdue && resolutionOverdue ? "breached" : resolutionOverdue ? "resolution_overdue" : "response_overdue";
    const update = await getPool().query(
      `UPDATE crm_records SET data=$1, updated_at=CURRENT_TIMESTAMP
        WHERE tenant_id=$2 AND id=$3
          AND (($4::boolean AND (data::jsonb ->> 'response_escalated_at') IS NULL) OR ($5::boolean AND (data::jsonb ->> 'resolution_escalated_at') IS NULL))
        RETURNING updated_at`,
      [JSON.stringify(data), row.tenant_id, row.id, responseOverdue, resolutionOverdue],
    );
    if (!update.rows[0]) continue;
    const actor = await resolveActor(row.tenant_id, row.owner_id, row.team_id);
    if (!actor) continue;
    const record: CrmRecord = {
      id: row.id, tenantId: row.tenant_id, teamId: row.team_id, ownerId: row.owner_id,
      type: "ticket", title: row.title, status: row.status, data,
      createdAt: String(row.created_at), updatedAt: String(update.rows[0].updated_at),
    };
    const message = resolutionOverdue ? `SLA résolution dépassé : ${row.title}` : `SLA prise en charge dépassé : ${row.title}`;
    await createNotification({ tenantId: actor.tenantId, recipientId: row.owner_id, type: "sla", message, resourceType: "ticket", resourceId: row.id });
    await appendTimeline(actor, record, "sla.escalated", message, { responseOverdue, resolutionOverdue });
    await audit(actor, { action: "sla.escalated", resourceType: "ticket", resourceId: row.id, result: "success", details: { responseOverdue, resolutionOverdue } });
    await enqueueAutomationJob(actor, "record.updated", record, { idempotencyKey: `sla:${row.id}:${data.sla_state}:${now.slice(0, 16)}` });
    processed += 1;
  }
  return processed;
}

async function loadSlaPolicy(tenantId: string): Promise<SlaPolicy> {
  const result = await getPool().query(
    `SELECT definition FROM crm_configurations
      WHERE tenant_id=$1 AND kind='module' AND config_key='support' AND active=1 LIMIT 1`,
    [tenantId],
  );
  const definition = parseData(result.rows[0]?.definition);
  const sla = definition.sla && typeof definition.sla === "object" && !Array.isArray(definition.sla)
    ? definition.sla as Record<string, unknown> : {};
  return {
    responseMinutes: positiveInt(sla.responseMinutes, DEFAULT_SLA.responseMinutes),
    resolutionMinutes: positiveInt(sla.resolutionMinutes, DEFAULT_SLA.resolutionMinutes),
    reminderMinutes: positiveInt(sla.reminderMinutes, DEFAULT_SLA.reminderMinutes),
  };
}

async function assertActiveTenantMember(tenantId: string, userId: string) {
  const result = await getPool().query("SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active' LIMIT 1", [tenantId, userId]);
  if (!result.rows[0]) throw new TicketingError("Demandeur absent du tenant.");
}
async function assertInternalTenantMember(tenantId: string, userId: string) {
  const result = await getPool().query("SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active' AND role IN ('admin','user') LIMIT 1", [tenantId, userId]);
  if (!result.rows[0]) throw new TicketingError("Intervenant absent du tenant.");
}
async function resolveInternalOwner(tenantId: string): Promise<AuthContext> {
  const result = await getPool().query(
    `SELECT m.user_id, m.team_id, m.role, u.email, u.display_name
       FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.tenant_id=$1 AND m.status='active' AND m.role IN ('admin','user')
      ORDER BY CASE WHEN m.role='admin' THEN 0 ELSE 1 END, m.created_at LIMIT 1`, [tenantId]);
  if (!result.rows[0]) throw new TicketingError("Aucun responsable interne disponible.", 409);
  const row = result.rows[0];
  return { userId: row.user_id, email: row.email, displayName: row.display_name, tenantId, teamId: row.team_id, role: row.role === "admin" ? "admin" : "user" };
}
async function resolveActor(tenantId: string, userId: string, teamId: string): Promise<AuthContext | null> {
  const result = await getPool().query("SELECT email, display_name FROM users WHERE id=$1 LIMIT 1", [userId]);
  if (!result.rows[0]) return null;
  return { userId, email: result.rows[0].email, displayName: result.rows[0].display_name, tenantId, teamId, role: "admin" };
}
function publicTicket(row: Record<string, unknown>) {
  const data = parseData(row.data);
  return {
    id: row.id, title: row.title, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt,
    priority: data.priority ?? "normal", category: data.category ?? "support", description: data.description ?? "",
    stage: data.stage ?? "", slaState: data.sla_state ?? "within",
  };
}
function parseData(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try { const parsed = JSON.parse(value) as unknown; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; }
}
function text(value: unknown, max: number) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function positiveInt(value: unknown, fallback: number) { const n = Number(value); return Number.isInteger(n) && n > 0 && n <= 525600 ? n : fallback; }
function due(value: unknown) { return typeof value === "string" && !Number.isNaN(Date.parse(value)) && Date.parse(value) <= Date.now(); }
function recordId(value: string) { return /^[A-Za-z0-9._:-]{1,100}$/.test(value); }

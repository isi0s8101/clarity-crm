import { getPool } from "@/db";
import { audit, type AuthContext } from "@/lib/authz";
import { enqueueAutomationJob } from "@/lib/automation-queue";
import { appendTimeline, type CrmRecord } from "@/lib/crm-core";
import { createNotification } from "@/lib/notifications";

const DEFAULT_REMINDER_MINUTES = 30;

type TicketRow = {
  id: string;
  tenant_id: string;
  team_id: string;
  owner_id: string;
  title: string;
  status: string;
  data: string | Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export async function processSlaOperations(limit = 50) {
  const cappedLimit = Math.max(1, Math.min(200, limit));
  const tenants = await getPool().query<{ tenant_id: string }>(
    `SELECT DISTINCT tenant_id FROM crm_records WHERE type='ticket' AND status <> 'archived' ORDER BY tenant_id LIMIT 100`,
  );
  let processed = 0;

  for (const tenant of tenants.rows) {
    if (processed >= cappedLimit) break;
    const reminderMinutes = await loadReminderMinutes(tenant.tenant_id);
    const rows = await getPool().query<TicketRow>(
      `SELECT id,tenant_id,team_id,owner_id,title,status,data,created_at,updated_at
         FROM crm_records
        WHERE tenant_id=$1 AND type='ticket' AND status <> 'archived'
          AND (
            ((data::jsonb ->> 'first_response_at') IS NULL AND (data::jsonb ->> 'response_due_at') IS NOT NULL
              AND (data::jsonb ->> 'response_due_at')::timestamptz <= CURRENT_TIMESTAMP + ($2 * INTERVAL '1 minute'))
            OR
            ((data::jsonb ->> 'resolved_at') IS NULL AND (data::jsonb ->> 'resolution_due_at') IS NOT NULL
              AND (data::jsonb ->> 'resolution_due_at')::timestamptz <= CURRENT_TIMESTAMP + ($2 * INTERVAL '1 minute'))
          )
        ORDER BY updated_at
        LIMIT $3`,
      [tenant.tenant_id, reminderMinutes, cappedLimit - processed],
    );

    for (const row of rows.rows) {
      if (processed >= cappedLimit) break;
      const data = parseObject(row.data);
      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();
      const responseDueMs = dateMs(data.response_due_at);
      const resolutionDueMs = dateMs(data.resolution_due_at);
      const responseOverdue = !data.first_response_at && !data.response_escalated_at && responseDueMs !== null && responseDueMs <= nowMs;
      const resolutionOverdue = !data.resolved_at && !data.resolution_escalated_at && resolutionDueMs !== null && resolutionDueMs <= nowMs;
      const responseReminder = !responseOverdue && !data.first_response_at && !data.response_reminder_sent_at && isReminderWindow(responseDueMs, nowMs, reminderMinutes);
      const resolutionReminder = !resolutionOverdue && !data.resolved_at && !data.resolution_reminder_sent_at && isReminderWindow(resolutionDueMs, nowMs, reminderMinutes);
      if (!responseReminder && !resolutionReminder && !responseOverdue && !resolutionOverdue) continue;

      const actor = await resolveInternalActor(row.tenant_id, row.owner_id, row.team_id);
      if (!actor) continue;
      if (responseReminder) data.response_reminder_sent_at = now;
      if (resolutionReminder) data.resolution_reminder_sent_at = now;
      if (responseOverdue) data.response_escalated_at = now;
      if (resolutionOverdue) data.resolution_escalated_at = now;
      if (responseOverdue || resolutionOverdue) {
        data.sla_state = responseOverdue && resolutionOverdue ? "breached" : resolutionOverdue ? "resolution_overdue" : "response_overdue";
      }

      const updated = await getPool().query<{ updated_at: string }>(
        `UPDATE crm_records SET data=$1,updated_at=CURRENT_TIMESTAMP
          WHERE tenant_id=$2 AND id=$3 AND (
            ($4::boolean AND (data::jsonb ->> 'response_reminder_sent_at') IS NULL)
            OR ($5::boolean AND (data::jsonb ->> 'resolution_reminder_sent_at') IS NULL)
            OR ($6::boolean AND (data::jsonb ->> 'response_escalated_at') IS NULL)
            OR ($7::boolean AND (data::jsonb ->> 'resolution_escalated_at') IS NULL)
          ) RETURNING updated_at`,
        [JSON.stringify(data), row.tenant_id, row.id, responseReminder, resolutionReminder, responseOverdue, resolutionOverdue],
      );
      if (!updated.rows[0]) continue;

      const record: CrmRecord = {
        id: row.id,
        tenantId: row.tenant_id,
        teamId: row.team_id,
        ownerId: row.owner_id,
        type: "ticket",
        title: row.title,
        status: row.status,
        data,
        createdAt: String(row.created_at),
        updatedAt: String(updated.rows[0].updated_at),
      };

      if (responseReminder) await emitSlaEvent(actor, record, "reminder", "response");
      if (resolutionReminder) await emitSlaEvent(actor, record, "reminder", "resolution");
      if (responseOverdue) await emitSlaEvent(actor, record, "escalated", "response");
      if (resolutionOverdue) await emitSlaEvent(actor, record, "escalated", "resolution");

      await enqueueAutomationJob(actor, "record.updated", record, {
        idempotencyKey: `sla:${row.id}:${responseReminder ? "rr" : ""}${resolutionReminder ? "lr" : ""}${responseOverdue ? "ro" : ""}${resolutionOverdue ? "lo" : ""}:${now}`,
      });
      processed += 1;
    }
  }
  return processed;
}

async function emitSlaEvent(actor: AuthContext, record: CrmRecord, kind: "reminder" | "escalated", target: "response" | "resolution") {
  const reminder = kind === "reminder";
  const label = target === "response" ? "prise en charge" : "résolution";
  const message = reminder ? `Rappel SLA ${label} à venir : ${record.title}` : `SLA ${label} dépassé : ${record.title}`;
  await createNotification({ tenantId: actor.tenantId, recipientId: record.ownerId, type: reminder ? "sla.reminder" : "sla", message, resourceType: "ticket", resourceId: record.id });
  await appendTimeline(actor, record, `sla.${kind}`, message, { target });
  await audit(actor, { action: `sla.${kind}`, resourceType: "ticket", resourceId: record.id, result: "success", details: { target } });
}

async function loadReminderMinutes(tenantId: string) {
  const result = await getPool().query<{ definition: string }>(
    `SELECT definition FROM crm_configurations WHERE tenant_id=$1 AND kind='module' AND config_key='support' AND active=1 LIMIT 1`,
    [tenantId],
  );
  const definition = parseObject(result.rows[0]?.definition);
  const sla = definition.sla && typeof definition.sla === "object" && !Array.isArray(definition.sla) ? definition.sla as Record<string, unknown> : {};
  const value = Number(sla.reminderMinutes);
  return Number.isInteger(value) && value > 0 && value <= 525600 ? value : DEFAULT_REMINDER_MINUTES;
}

async function resolveInternalActor(tenantId: string, userId: string, fallbackTeamId: string): Promise<AuthContext | null> {
  const result = await getPool().query<{ team_id: string | null; role: string; email: string; display_name: string }>(
    `SELECT m.team_id,m.role,u.email,u.display_name
       FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.status='active' AND m.role IN ('admin','user') LIMIT 1`,
    [tenantId, userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { userId, email: row.email, displayName: row.display_name, tenantId, teamId: row.team_id || fallbackTeamId, role: row.role === "admin" ? "admin" : "user" };
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function dateMs(value: unknown) {
  if (typeof value !== "string") return null;
  const valueMs = Date.parse(value);
  return Number.isNaN(valueMs) ? null : valueMs;
}

function isReminderWindow(dueMs: number | null, nowMs: number, reminderMinutes: number) {
  return dueMs !== null && dueMs > nowMs && dueMs - nowMs <= reminderMinutes * 60000;
}

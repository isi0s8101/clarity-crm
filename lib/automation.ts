import { and, eq } from "drizzle-orm";

import { getDb } from "@/db";
import {
  automationRuns,
  crmConfigurations,
  crmRecords,
  crmTimelineEvents,
} from "@/db/schema";
import {
  audit,
  canUseResource,
  requirePermission,
  requireRecordPermission,
  type AuthContext,
} from "@/lib/authz";
import { createNotification } from "@/lib/notifications";
import { dispatchAutomationWebhook } from "@/lib/webhooks";
import {
  evaluateAutomationConditions,
  normalizeRecordStatus,
  renderAutomationTemplate,
  validateRecordInput,
} from "@/lib/crm-policy.js";

export type AutomationEvent =
  | "record.created"
  | "record.updated"
  | "record.archived"
  | "record.status_changed"
  | "record.pipeline_changed";

type RuntimeRecord = {
  id: string;
  tenantId: string;
  teamId: string;
  ownerId: string;
  type: string;
  title: string;
  status: string;
  data: Record<string, unknown>;
};

export async function runAutomations(
  actor: AuthContext,
  event: AutomationEvent,
  record: RuntimeRecord,
  context: { correlationId?: string; depth?: number; attempt?: number } = {},
) {
  const correlationId = context.correlationId ?? crypto.randomUUID();
  const depth = context.depth ?? 0;
  const attempt = Math.min(Math.max(context.attempt ?? 1, 1), 5);
  if (depth > 4) return;
  const db = getDb();
  const configs = await db
    .select()
    .from(crmConfigurations)
    .where(
      and(
        eq(crmConfigurations.tenantId, actor.tenantId),
        eq(crmConfigurations.kind, "automation"),
        eq(crmConfigurations.active, 1),
      ),
    )
    .limit(25);

  for (const config of configs) {
    let definition: Record<string, unknown>;
    try {
      definition = JSON.parse(config.definition) as Record<string, unknown>;
    } catch {
      await recordRun(actor, config.id, event, "failure", record, [], "Définition JSON invalide.", correlationId, depth, attempt);
      continue;
    }

    const trigger = asObject(definition.trigger);
    if (trigger?.event !== event) continue;
    if (typeof trigger.type === "string" && trigger.type !== record.type) continue;

    const conditions = Array.isArray(definition.conditions) ? definition.conditions : [];
    if (!evaluateAutomationConditions(conditions, record)) {
      await recordRun(actor, config.id, event, "skipped", record, [], "", correlationId, depth, attempt);
      continue;
    }

    const prior = await db.select({ id: automationRuns.id }).from(automationRuns).where(
      and(
        eq(automationRuns.tenantId, actor.tenantId),
        eq(automationRuns.automationId, config.id),
        eq(automationRuns.correlationId, correlationId),
      ),
    ).limit(1);
    if (prior[0]) continue;
    const actions = Array.isArray(definition.actions) ? definition.actions.slice(0, 10) : [];
    const outputs: Array<Record<string, unknown>> = [];
    let failure = "";

    try {
      for (const rawAction of actions) {
        const action = asObject(rawAction);
        if (!action || typeof action.kind !== "string") continue;

        if (action.kind === "create_task") {
          await requireRecordPermission(actor, "task", "create");
          const title = renderAutomationTemplate(action.title, record);
          const taskPayload = validateRecordInput({
            type: "task",
            title,
            status: "active",
            data: {
              sourceRecordId: record.id,
              automationId: config.id,
              dueAt: typeof action.dueAt === "string" ? action.dueAt : undefined,
              completed: false,
            },
          });
          if (!taskPayload.ok) throw new Error(taskPayload.error);
          const id = crypto.randomUUID();
          await db.insert(crmRecords).values({
            id,
            tenantId: actor.tenantId,
            teamId: actor.teamId,
            ownerId: actor.userId,
            type: "task",
            title: taskPayload.value.title,
            status: taskPayload.value.status,
            data: JSON.stringify(taskPayload.value.data),
          });
          await db.insert(crmTimelineEvents).values({
            tenantId: actor.tenantId,
            teamId: actor.teamId,
            ownerId: actor.userId,
            recordId: id,
            eventType: "automation.created",
            summary: `Tâche créée par ${config.name}`,
            data: JSON.stringify({ automationId: config.id, sourceRecordId: record.id, correlationId }),
            actorId: actor.userId,
          });
          outputs.push({ kind: "create_task", recordId: id });
          continue;
        }

        if (action.kind === "set_status") {
          const status = normalizeRecordStatus(action.status, null);
          if (!status) throw new Error("Statut d'automatisation invalide.");
          const scope = await requireRecordPermission(actor, record.type, "update");
          if (!canUseResource(actor, scope, record)) throw new Error("Scope insuffisant pour modifier le statut.");
          await db
            .update(crmRecords)
            .set({ status, updatedAt: new Date().toISOString() })
            .where(
              and(
                eq(crmRecords.id, record.id),
                eq(crmRecords.tenantId, actor.tenantId),
              ),
            );
          record.status = status;
          outputs.push({ kind: "set_status", status });
          continue;
        }

        if (action.kind === "timeline") {
          await requirePermission(actor, "timeline", "create");
          const summary = renderAutomationTemplate(action.summary, record);
          await db.insert(crmTimelineEvents).values({
            tenantId: actor.tenantId,
            teamId: record.teamId,
            ownerId: record.ownerId,
            recordId: record.id,
            eventType: "automation.note",
            summary,
            data: JSON.stringify({ automationId: config.id, correlationId }),
            actorId: actor.userId,
          });
          outputs.push({ kind: "timeline", summary });
          continue;
        }

        if (action.kind === "update_field") {
          const field = typeof action.field === "string" ? action.field : "";
          if (!/^[a-z][a-z0-9_]{0,49}$/.test(field)) throw new Error("Champ d'automatisation invalide.");
          const scope = await requireRecordPermission(actor, record.type, "update");
          if (!canUseResource(actor, scope, record)) throw new Error("Scope insuffisant pour modifier le champ.");
          const value = typeof action.value === "string" ? renderAutomationTemplate(action.value, record) : action.value;
          const data = { ...record.data, [field]: value };
          await db.update(crmRecords).set({ data: JSON.stringify(data), updatedAt: new Date().toISOString() }).where(
            and(eq(crmRecords.id, record.id), eq(crmRecords.tenantId, actor.tenantId)),
          );
          record.data = data;
          outputs.push({ kind: "update_field", field });
          continue;
        }

        if (action.kind === "webhook") {
          if (typeof action.url !== "string") throw new Error("URL webhook d'automatisation invalide.");
          await dispatchAutomationWebhook(actor, config.id, event, record, action.url, correlationId);
          outputs.push({ kind: "webhook" });
          continue;
        }

        if (action.kind === "notify_owner") {
          const message = renderAutomationTemplate(action.message, record);
          const notification = await createNotification({
            tenantId: actor.tenantId, recipientId: record.ownerId, type: "automation", message,
            resourceType: record.type, resourceId: record.id,
          });
          outputs.push({ kind: "notify_owner", notificationId: notification.id });
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : "Erreur d'automatisation.";
    }

    const status = failure ? "failure" : "success";
    await recordRun(actor, config.id, event, status, record, outputs, failure, correlationId, depth, attempt);
    await audit(actor, {
      action: `automation.${status}`,
      resourceType: "automation",
      resourceId: config.id,
      result: failure ? "failure" : "success",
      details: { event, recordId: record.id, correlationId, depth, outputs, error: failure || undefined },
    });
  }
}

async function recordRun(
  actor: AuthContext,
  automationId: string,
  event: string,
  status: string,
  record: RuntimeRecord,
  outputs: Array<Record<string, unknown>>,
  error: string,
  correlationId: string,
  depth: number,
  attempt: number,
) {
  const db = getDb();
  await db.insert(automationRuns).values({
    id: crypto.randomUUID(),
    tenantId: actor.tenantId,
    automationId,
    status,
    input: JSON.stringify({ event, recordId: record.id, type: record.type }),
    output: JSON.stringify({ actions: outputs }),
    error: error.slice(0, 2000),
    correlationId,
    depth,
    attempt,
  });
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

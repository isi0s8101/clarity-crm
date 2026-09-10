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
import {
  evaluateAutomationConditions,
  normalizeRecordStatus,
  renderAutomationTemplate,
  validateRecordInput,
} from "@/lib/crm-policy.js";

export type AutomationEvent = "record.created" | "record.updated" | "record.archived";

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
) {
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
      await recordRun(actor, config.id, event, "failure", record, [], "Définition JSON invalide.");
      continue;
    }

    const trigger = asObject(definition.trigger);
    if (trigger?.event !== event) continue;
    if (typeof trigger.type === "string" && trigger.type !== record.type) continue;

    const conditions = Array.isArray(definition.conditions) ? definition.conditions : [];
    if (!evaluateAutomationConditions(conditions, record)) {
      await recordRun(actor, config.id, event, "skipped", record, [], "");
      continue;
    }

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
            data: JSON.stringify({ automationId: config.id, sourceRecordId: record.id }),
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
            data: JSON.stringify({ automationId: config.id }),
            actorId: actor.userId,
          });
          outputs.push({ kind: "timeline", summary });
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : "Erreur d'automatisation.";
    }

    const status = failure ? "failure" : "success";
    await recordRun(actor, config.id, event, status, record, outputs, failure);
    await audit(actor, {
      action: `automation.${status}`,
      resourceType: "automation",
      resourceId: config.id,
      result: failure ? "failure" : "success",
      details: { event, recordId: record.id, outputs, error: failure || undefined },
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
  });
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { getDb, getPool } from "@/db";
import { automationJobs, automationRuns, crmConfigurations } from "@/db/schema";
import {
  audit,
  authErrorResponse,
  requirePermission,
  resolveAuthContext,
} from "@/lib/authz";
import {
  cancelAutomationJob,
  enqueueAutomationJob,
  retryAutomationJob,
} from "@/lib/automation-queue";
import type { AutomationEvent } from "@/lib/automation";
import { ApiInputError, apiError, parsePagination } from "@/lib/api-response";
import { crmErrorResponse, getCrmRecord } from "@/lib/crm-core";
import { assertSameOriginMutation } from "@/lib/native-auth";

const allowedEvents = new Set<AutomationEvent>([
  "record.created",
  "record.updated",
  "record.archived",
  "record.status_changed",
  "record.pipeline_changed",
]);
const allowedStatuses = new Set(["pending", "running", "retrying", "success", "failed"]);

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "automation", "read");
    const { limit, offset } = parsePagination(request.nextUrl.searchParams);
    const status = request.nextUrl.searchParams.get("status") ?? "";
    const jobId = request.nextUrl.searchParams.get("jobId") ?? "";
    if (status && !allowedStatuses.has(status)) {
      return apiError("Statut de job invalide.", 400, "AUTOMATION_STATUS_INVALID");
    }
    if (jobId && !/^[A-Za-z0-9._:-]{1,120}$/.test(jobId)) {
      return apiError("Identifiant de job invalide.", 400, "AUTOMATION_JOB_ID_INVALID");
    }

    const db = getDb();
    const jobCondition = jobId
      ? and(eq(automationJobs.tenantId, actor.tenantId), eq(automationJobs.id, jobId))
      : status
        ? and(eq(automationJobs.tenantId, actor.tenantId), eq(automationJobs.status, status))
        : eq(automationJobs.tenantId, actor.tenantId);
    const [configs, jobs] = await Promise.all([
      db
        .select()
        .from(crmConfigurations)
        .where(
          and(
            eq(crmConfigurations.tenantId, actor.tenantId),
            eq(crmConfigurations.kind, "automation"),
          ),
        )
        .orderBy(desc(crmConfigurations.updatedAt))
        .limit(100),
      db
        .select()
        .from(automationJobs)
        .where(jobCondition)
        .orderBy(desc(automationJobs.createdAt))
        .limit(jobId ? 1 : limit)
        .offset(jobId ? 0 : offset),
    ]);
    if (jobId && jobs.length === 0) {
      return apiError("Job d'automatisation introuvable.", 404, "AUTOMATION_JOB_NOT_FOUND");
    }

    const correlationId = jobId ? jobs[0]?.correlationId ?? "" : "";
    const runs = await db
      .select()
      .from(automationRuns)
      .where(
        correlationId
          ? and(
              eq(automationRuns.tenantId, actor.tenantId),
              eq(automationRuns.correlationId, correlationId),
            )
          : eq(automationRuns.tenantId, actor.tenantId),
      )
      .orderBy(desc(automationRuns.createdAt))
      .limit(jobId ? 200 : limit)
      .offset(jobId ? 0 : offset);
    const metricRows = await getPool().query(
      "SELECT status, COUNT(*)::int AS count FROM automation_jobs WHERE tenant_id=$1 GROUP BY status",
      [actor.tenantId],
    );
    const metrics = Object.fromEntries(
      metricRows.rows.map((row) => [String(row.status), Number(row.count)]),
    );

    return NextResponse.json({
      configurations: configs.map((config) => ({
        ...config,
        active: config.active === 1,
        definition: safeJson(config.definition),
      })),
      runs: runs.map((run) => ({
        ...run,
        input: safeJson(run.input),
        output: safeJson(run.output),
      })),
      jobs: jobs.map((job) => ({ ...job, payload: safeJson(job.payload) })),
      metrics,
      pagination: { limit: jobId ? 1 : limit, offset: jobId ? 0 : offset },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof ApiInputError) {
      return apiError(error.message, 400, "PAGINATION_INVALID");
    }
    console.error("automations:list", error);
    return apiError("Automatisations indisponibles.", 503, "AUTOMATION_UNAVAILABLE");
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "automation", "administer");
    const body = (await request.json()) as Record<string, unknown>;
    const recordId = typeof body.recordId === "string" ? body.recordId : "";
    const event = typeof body.event === "string" ? body.event as AutomationEvent : "record.updated";
    if (!allowedEvents.has(event)) {
      return apiError("Événement invalide.", 400, "AUTOMATION_EVENT_INVALID");
    }
    const record = await getCrmRecord(actor, recordId, "read");
    const queued = await enqueueAutomationJob(actor, event, record, {
      idempotencyKey: "manual:" + actor.userId + ":" + event + ":" + record.id + ":" + crypto.randomUUID(),
    });
    await audit(actor, {
      action: "automation.replayed",
      resourceType: record.type,
      resourceId: record.id,
      result: "success",
      details: { event, jobId: queued.id, correlationId: queued.correlationId },
    });
    return NextResponse.json({ queued: queued.queued, jobId: queued.id, correlationId: queued.correlationId }, { status: 202 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    if (error instanceof SyntaxError) {
      return apiError("Corps JSON invalide.", 400, "JSON_INVALID");
    }
    console.error("automations:replay", error);
    return apiError("Exécution d'automatisation impossible.", 503, "AUTOMATION_REPLAY_FAILED");
  }
}

export async function PATCH(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "automation", "administer");
    const body = (await request.json()) as Record<string, unknown>;
    const jobId = typeof body.jobId === "string" ? body.jobId : "";
    const action = typeof body.action === "string" ? body.action : "";
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(jobId)) {
      return apiError("Identifiant de job invalide.", 400, "AUTOMATION_JOB_ID_INVALID");
    }
    if (action !== "retry" && action !== "cancel") {
      return apiError("Action administrative invalide.", 400, "AUTOMATION_ACTION_INVALID");
    }

    const db = getDb();
    const current = await db
      .select({ id: automationJobs.id, status: automationJobs.status })
      .from(automationJobs)
      .where(and(eq(automationJobs.tenantId, actor.tenantId), eq(automationJobs.id, jobId)))
      .limit(1);
    if (!current[0]) {
      return apiError("Job d'automatisation introuvable.", 404, "AUTOMATION_JOB_NOT_FOUND");
    }

    const updated = action === "retry"
      ? await retryAutomationJob(actor.tenantId, jobId)
      : await cancelAutomationJob(actor.tenantId, jobId);
    if (!updated) {
      const message = action === "retry"
        ? "Seul un job en échec peut être relancé administrativement."
        : "Seul un job pending/retrying peut être annulé sans interrompre un worker actif.";
      return apiError(message, 409, "AUTOMATION_JOB_STATE_CONFLICT", { status: current[0].status });
    }

    await audit(actor, {
      action: action === "retry" ? "automation.job.retried" : "automation.job.cancelled",
      resourceType: "automation_job",
      resourceId: jobId,
      result: "success",
      details: { previousStatus: current[0].status },
    });
    return NextResponse.json({
      job: { ...updated, payload: safeJson(String(updated.payload ?? "{}")) },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof SyntaxError) {
      return apiError("Corps JSON invalide.", 400, "JSON_INVALID");
    }
    console.error("automations:admin", error);
    return apiError("Action administrative impossible.", 503, "AUTOMATION_ADMIN_FAILED");
  }
}

function safeJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

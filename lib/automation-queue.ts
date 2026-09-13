import { getPool } from "@/db";
import type { AuthContext } from "@/lib/authz";
import { runAutomations, type AutomationEvent } from "@/lib/automation";
import {
  executeIntegrationSyncJob,
  IntegrationJobError,
  type IntegrationSyncDescriptor,
} from "@/lib/integration-sync";
import { refreshProactiveRecord, refreshProactiveSweep } from "@/lib/v12-intelligence";
import { dispatchOutboundWebhooks, type WebhookEvent } from "@/lib/webhooks";

type QueueRecord = {
  id: string; tenantId: string; teamId: string; ownerId: string; type: string;
  title: string; status: string; data: Record<string, unknown>; updatedAt?: string;
};
type QueueMode = "event" | "webhook_only" | "proactive_refresh" | "proactive_sweep" | "integration_sync";
type QueuePayload = {
  actor: AuthContext;
  event: AutomationEvent | "system.proactive_refresh" | "system.proactive_sweep" | "system.integration_sync";
  record: QueueRecord;
  depth: number;
  mode?: QueueMode;
  webhookId?: string;
  integration?: IntegrationSyncDescriptor;
};
type QueueContext = {
  correlationId?: string;
  depth?: number;
  idempotencyKey?: string;
  mode?: "event" | "webhook_only";
  webhookId?: string;
};

export async function enqueueAutomationJob(
  actor: AuthContext, event: AutomationEvent, record: QueueRecord,
  context: QueueContext = {},
) {
  const correlationId = context.correlationId ?? crypto.randomUUID();
  const depth = Math.max(0, Math.min(4, context.depth ?? 0));
  const mode = context.mode ?? "event";
  if (mode === "webhook_only" && (!context.webhookId || context.webhookId.length > 120)) {
    throw new Error("Webhook de relance invalide.");
  }
  const payload = JSON.stringify({
    actor,
    event,
    record,
    depth,
    mode,
    ...(context.webhookId ? { webhookId: context.webhookId } : {}),
  });
  if (Buffer.byteLength(payload, "utf8") > 131072) {
    throw new Error("Payload d'automatisation trop volumineux.");
  }
  const idempotencyKey = context.idempotencyKey
    ?? [mode, event, record.id, record.updatedAt ?? "", correlationId].join(":").slice(0, 240);
  const result = await getPool().query(
    "INSERT INTO automation_jobs (id, tenant_id, event, payload, correlation_id, idempotency_key, status, available_at) "
      + "VALUES ($1,$2,$3,$4,$5,$6,'pending',CURRENT_TIMESTAMP) "
      + "ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id",
    [crypto.randomUUID(), actor.tenantId, event, payload, correlationId, idempotencyKey],
  );
  return { id: result.rows[0]?.id ?? null, correlationId, queued: Boolean(result.rows[0]) };
}

export async function enqueueProactiveRefreshJob(actor: AuthContext, record: QueueRecord) {
  const correlationId = crypto.randomUUID();
  const event = "system.proactive_refresh" as const;
  const payload: QueuePayload = { actor, event, record, depth: 0, mode: "proactive_refresh" };
  const idempotencyKey = [event, record.id, record.updatedAt ?? ""].join(":").slice(0, 240);
  const result = await getPool().query(
    `INSERT INTO automation_jobs(id,tenant_id,event,payload,correlation_id,idempotency_key,status,available_at)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',CURRENT_TIMESTAMP)
     ON CONFLICT(tenant_id,idempotency_key) DO NOTHING RETURNING id`,
    [crypto.randomUUID(), actor.tenantId, event, JSON.stringify(payload), correlationId, idempotencyKey],
  );
  return { id: result.rows[0]?.id ?? null, correlationId, queued: Boolean(result.rows[0]) };
}

export async function enqueueProactiveSweepJob(actor: AuthContext, delaySeconds = 0) {
  const interval = envInteger("CLARITY_PROACTIVE_SWEEP_INTERVAL_SECONDS", 21600, 3600, 86400);
  const availableAtMs = Date.now() + Math.max(0, delaySeconds) * 1000;
  const bucket = Math.floor(availableAtMs / (interval * 1000));
  const event = "system.proactive_sweep" as const;
  const correlationId = crypto.randomUUID();
  const record: QueueRecord = {
    id: `tenant:${actor.tenantId}`,
    tenantId: actor.tenantId,
    teamId: actor.teamId,
    ownerId: actor.userId,
    type: "system",
    title: "Proactive sweep",
    status: "active",
    data: {},
  };
  const payload: QueuePayload = { actor, event, record, depth: 0, mode: "proactive_sweep" };
  const idempotencyKey = `${event}:${actor.tenantId}:${bucket}`;
  const result = await getPool().query(
    `INSERT INTO automation_jobs(id,tenant_id,event,payload,correlation_id,idempotency_key,status,available_at)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',CURRENT_TIMESTAMP + ($7 * INTERVAL '1 second'))
     ON CONFLICT(tenant_id,idempotency_key) DO NOTHING RETURNING id`,
    [crypto.randomUUID(), actor.tenantId, event, JSON.stringify(payload), correlationId, idempotencyKey, Math.max(0, delaySeconds)],
  );
  return { id: result.rows[0]?.id ?? null, correlationId, queued: Boolean(result.rows[0]) };
}

export async function processAutomationJobs(options: { workerId?: string; limit?: number } = {}) {
  const workerId = options.workerId ?? "automation-" + process.pid;
  const limit = Math.max(1, Math.min(100, options.limit ?? 20));
  await recoverStaleAutomationJobs();
  let processed = 0;
  while (processed < limit) {
    const job = await claimAutomationJob(workerId);
    if (!job) break;
    await processAutomationJob(job, workerId);
    processed += 1;
  }
  return processed;
}

export async function recoverStaleAutomationJobs() {
  const timeoutSeconds = envInteger("CLARITY_AUTOMATION_JOB_TIMEOUT_SECONDS", 120, 10, 3600);
  await getPool().query(
    "UPDATE automation_jobs SET status='retrying', available_at=CURRENT_TIMESTAMP, locked_at=NULL, locked_by='', "
      + "last_error=CASE WHEN last_error='' THEN 'Worker interrompu : reprise automatique.' ELSE last_error END "
      + "WHERE status='running' AND locked_at < CURRENT_TIMESTAMP - ($1 * INTERVAL '1 second')",
    [timeoutSeconds],
  );
}

export async function retryAutomationJob(tenantId: string, jobId: string) {
  const result = await getPool().query(
    "UPDATE automation_jobs SET status='pending', attempts=0, available_at=CURRENT_TIMESTAMP, started_at=NULL, "
      + "finished_at=NULL, locked_at=NULL, locked_by='', last_error='' "
      + "WHERE tenant_id=$1 AND id=$2 AND status='failed' RETURNING *",
    [tenantId, jobId],
  );
  return result.rows[0] as Record<string, unknown> | undefined;
}

export async function cancelAutomationJob(tenantId: string, jobId: string) {
  const result = await getPool().query(
    "UPDATE automation_jobs SET status='failed', finished_at=CURRENT_TIMESTAMP, locked_at=NULL, locked_by='', "
      + "last_error='Annulé administrativement avant exécution.' "
      + "WHERE tenant_id=$1 AND id=$2 AND status IN ('pending','retrying') RETURNING *",
    [tenantId, jobId],
  );
  return result.rows[0] as Record<string, unknown> | undefined;
}

async function claimAutomationJob(workerId: string) {
  const result = await getPool().query(
    "WITH candidate AS (SELECT id FROM automation_jobs WHERE status IN ('pending','retrying') "
      + "AND available_at <= CURRENT_TIMESTAMP ORDER BY available_at, created_at FOR UPDATE SKIP LOCKED LIMIT 1) "
      + "UPDATE automation_jobs AS job SET status='running', attempts=attempts+1, started_at=CURRENT_TIMESTAMP, "
      + "locked_at=CURRENT_TIMESTAMP, locked_by=$1 FROM candidate WHERE job.id=candidate.id RETURNING job.*",
    [workerId],
  );
  return result.rows[0] as Record<string, unknown> | undefined;
}

async function processAutomationJob(job: Record<string, unknown>, workerId: string) {
  const jobId = String(job.id);
  try {
    const payload = parsePayload(String(job.payload ?? ""));
    if (payload.depth > 4) throw new NonRetryableAutomationError("Profondeur maximale d'automatisation atteinte.");

    if (payload.mode === "integration_sync") {
      if (payload.event !== "system.integration_sync" || !payload.integration) {
        throw new NonRetryableAutomationError("Job de synchronisation d'intégration incohérent.");
      }
      await executeIntegrationSyncJob(payload.actor, payload.integration, {
        jobId,
        correlationId: String(job.correlation_id),
        attempt: Number(job.attempts ?? 1),
        maxAttempts: Number(job.max_attempts ?? 5),
      });
    } else if (payload.mode === "proactive_refresh") {
      await refreshProactiveRecord(payload.actor, payload.record.id);
    } else if (payload.mode === "proactive_sweep") {
      await refreshProactiveSweep(payload.actor, envInteger("CLARITY_PROACTIVE_SWEEP_RECORD_LIMIT", 500, 1, 1000));
      await enqueueProactiveSweepJob(
        payload.actor,
        envInteger("CLARITY_PROACTIVE_SWEEP_INTERVAL_SECONDS", 21600, 3600, 86400),
      );
    } else if (payload.mode === "webhook_only") {
      if (!payload.webhookId || !isWebhookEvent(payload.event)) {
        throw new NonRetryableAutomationError("Relance webhook invalide.");
      }
      const result = await dispatchOutboundWebhooks(
        payload.actor,
        payload.event,
        payload.record,
        String(job.correlation_id),
        jobId,
        payload.webhookId,
      );
      if (result.attempted !== 1 || result.failed !== 0) {
        throw new Error(result.attempted === 0
          ? "Webhook de relance introuvable ou inactif."
          : "Nouvel échec de livraison webhook.");
      }
    } else {
      if (!isAutomationEvent(payload.event)) throw new NonRetryableAutomationError("Événement d'automatisation invalide.");
      await runAutomations(payload.actor, payload.event, payload.record, {
        correlationId: String(job.correlation_id), depth: payload.depth, attempt: Number(job.attempts), jobId,
      });
      if (isWebhookEvent(payload.event)) {
        await dispatchOutboundWebhooks(payload.actor, payload.event, payload.record, String(job.correlation_id), jobId);
      }
    }

    await getPool().query(
      "UPDATE automation_jobs SET status='success', finished_at=CURRENT_TIMESTAMP, locked_at=NULL, locked_by='', last_error='' "
        + "WHERE id=$1 AND locked_by=$2", [jobId, workerId],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 2000) : "Erreur worker inconnue.";
    const attempts = Number(job.attempts ?? 1);
    const maxAttempts = Number(job.max_attempts ?? 5);
    const retry = error instanceof IntegrationJobError
      ? error.retryable && attempts < maxAttempts
      : !(error instanceof NonRetryableAutomationError) && attempts < maxAttempts;
    const requestedDelay = error instanceof IntegrationJobError ? error.retryAfterSeconds : undefined;
    const delay = requestedDelay === undefined
      ? Math.min(3600, 5 * 2 ** Math.max(0, attempts - 1))
      : Math.min(86400, Math.max(1, requestedDelay));
    const statement = retry
      ? "UPDATE automation_jobs SET status='retrying', available_at=CURRENT_TIMESTAMP + ($1 * INTERVAL '1 second'), locked_at=NULL, locked_by='', last_error=$2 WHERE id=$3 AND locked_by=$4"
      : "UPDATE automation_jobs SET status='failed', finished_at=CURRENT_TIMESTAMP, locked_at=NULL, locked_by='', last_error=$1 WHERE id=$2 AND locked_by=$3";
    await getPool().query(statement, retry ? [delay, message, jobId, workerId] : [message, jobId, workerId]);
    console.error(JSON.stringify({ level: "error", component: "automation-worker", jobId, attempts, retry, error: message }));
  }
}

function parsePayload(value: string): QueuePayload {
  const parsed = JSON.parse(value) as Partial<QueuePayload>;
  if (!parsed.actor || !parsed.record || typeof parsed.event !== "string" || typeof parsed.depth !== "number") {
    throw new NonRetryableAutomationError("Payload d'automatisation invalide.");
  }
  if (parsed.mode !== undefined && !["event", "webhook_only", "proactive_refresh", "proactive_sweep", "integration_sync"].includes(parsed.mode)) {
    throw new NonRetryableAutomationError("Mode de job invalide.");
  }
  if ((parsed.mode === "proactive_refresh" && parsed.event !== "system.proactive_refresh")
    || (parsed.mode === "proactive_sweep" && parsed.event !== "system.proactive_sweep")
    || (parsed.mode === "integration_sync" && parsed.event !== "system.integration_sync")) {
    throw new NonRetryableAutomationError("Job système incohérent.");
  }
  if (parsed.mode === "integration_sync" && !isIntegrationDescriptor(parsed.integration)) {
    throw new NonRetryableAutomationError("Descripteur de synchronisation invalide.");
  }
  return parsed as QueuePayload;
}
function isIntegrationDescriptor(value: unknown): value is IntegrationSyncDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<IntegrationSyncDescriptor>;
  return typeof item.runId === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(item.runId)
    && typeof item.connectionId === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(item.connectionId)
    && typeof item.resourceType === "string" && /^[a-z][a-z0-9._:-]{0,79}$/.test(item.resourceType)
    && (item.direction === "pull" || item.direction === "push");
}
function isAutomationEvent(event: QueuePayload["event"]): event is AutomationEvent {
  return event === "record.created" || event === "record.updated" || event === "record.archived"
    || event === "record.status_changed" || event === "record.pipeline_changed";
}
function isWebhookEvent(event: QueuePayload["event"]): event is WebhookEvent {
  return event === "record.created" || event === "record.updated" || event === "record.archived";
}
function envInteger(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}
export class NonRetryableAutomationError extends Error {}

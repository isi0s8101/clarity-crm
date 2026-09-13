import { getPool } from "@/db";
import type { AuthContext } from "@/lib/authz";
import { runAutomations, type AutomationEvent } from "@/lib/automation";
import { dispatchOutboundWebhooks, type WebhookEvent } from "@/lib/webhooks";

type QueueRecord = {
  id: string; tenantId: string; teamId: string; ownerId: string; type: string;
  title: string; status: string; data: Record<string, unknown>; updatedAt?: string;
};
type QueuePayload = { actor: AuthContext; event: AutomationEvent; record: QueueRecord; depth: number };

export async function enqueueAutomationJob(
  actor: AuthContext, event: AutomationEvent, record: QueueRecord,
  context: { correlationId?: string; depth?: number; idempotencyKey?: string } = {},
) {
  const correlationId = context.correlationId ?? crypto.randomUUID();
  const depth = Math.max(0, Math.min(4, context.depth ?? 0));
  const payload = JSON.stringify({ actor, event, record, depth });
  if (payload.length > 131072) throw new Error("Payload d'automatisation trop volumineux.");
  const idempotencyKey = context.idempotencyKey
    ?? [event, record.id, record.updatedAt ?? "", correlationId].join(":").slice(0, 240);
  const result = await getPool().query(
    "INSERT INTO automation_jobs (id, tenant_id, event, payload, correlation_id, idempotency_key, status, available_at) "
      + "VALUES ($1,$2,$3,$4,$5,$6,'pending',CURRENT_TIMESTAMP) "
      + "ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id",
    [crypto.randomUUID(), actor.tenantId, event, payload, correlationId, idempotencyKey],
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
    await runAutomations(payload.actor, payload.event, payload.record, {
      correlationId: String(job.correlation_id), depth: payload.depth, attempt: Number(job.attempts), jobId,
    });
    if (isWebhookEvent(payload.event)) {
      await dispatchOutboundWebhooks(payload.actor, payload.event, payload.record, String(job.correlation_id), jobId);
    }
    await getPool().query(
      "UPDATE automation_jobs SET status='success', finished_at=CURRENT_TIMESTAMP, locked_at=NULL, locked_by='', last_error='' "
        + "WHERE id=$1 AND locked_by=$2", [jobId, workerId],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 2000) : "Erreur worker inconnue.";
    const attempts = Number(job.attempts ?? 1);
    const retry = !(error instanceof NonRetryableAutomationError) && attempts < Number(job.max_attempts ?? 5);
    const delay = Math.min(3600, 5 * 2 ** Math.max(0, attempts - 1));
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
  return parsed as QueuePayload;
}
function isWebhookEvent(event: AutomationEvent): event is WebhookEvent {
  return event === "record.created" || event === "record.updated" || event === "record.archived";
}
function envInteger(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}
export class NonRetryableAutomationError extends Error {}

import { getPool } from "@/db";
import { audit, type AuthContext } from "@/lib/authz";
import {
  buildRuntimeContext,
  getIntegrationConnection,
  requireIntegrationSyncPermission,
  type IntegrationConnectionView,
} from "@/lib/integration-manager";
import {
  IntegrationNormalizationError,
  normalizeIntegrationPullItem,
  type ExistingIntegrationTarget,
} from "@/lib/integration-normalizer";
import { ConnectorError } from "@/lib/integrations/connector";
import { getIntegrationConnector } from "@/lib/integrations/registry";

const RESOURCE_RE = /^[a-z][a-z0-9._:-]{0,79}$/;
const DIRECTIONS = new Set(["pull", "push"]);
const TRIGGERS = new Set(["initial", "manual", "scheduled", "retry", "webhook"]);

export type IntegrationSyncDescriptor = {
  runId: string;
  connectionId: string;
  resourceType: string;
  direction: "pull" | "push";
};

export async function requestIntegrationSync(actor: AuthContext, input: {
  connectionId: string;
  resourceType: string;
  direction?: "pull" | "push";
  triggerKind?: "initial" | "manual" | "scheduled" | "retry" | "webhook";
}) {
  await requireIntegrationSyncPermission(actor);
  const connection = await getIntegrationConnection(actor, input.connectionId);
  if (["disabled", "revoked", "draft", "connecting"].includes(connection.status)) {
    throw new IntegrationSyncValidationError("Connexion non disponible pour synchronisation.");
  }
  const resourceType = normalizeResourceType(input.resourceType);
  const direction = input.direction ?? "pull";
  if (!DIRECTIONS.has(direction)) throw new IntegrationSyncValidationError("Direction de synchronisation invalide.");
  const triggerKind = input.triggerKind ?? "manual";
  if (!TRIGGERS.has(triggerKind)) throw new IntegrationSyncValidationError("Déclencheur de synchronisation invalide.");
  const connector = getIntegrationConnector(connection.provider);
  if (direction === "pull" && !connector.pull) throw new IntegrationSyncValidationError("Lecture non prise en charge par ce connecteur.");
  if (direction === "push" && !connector.push) throw new IntegrationSyncValidationError("Écriture non prise en charge par ce connecteur.");

  const cursor = await getCursor(connection, resourceType, direction);
  const runId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const correlationId = crypto.randomUUID();
  const descriptor: IntegrationSyncDescriptor = { runId, connectionId: connection.id, resourceType, direction };
  const record = {
    id: `integration:${connection.id}:${resourceType}`,
    tenantId: actor.tenantId,
    teamId: actor.teamId,
    ownerId: actor.userId,
    type: "integration",
    title: `${connection.name} — ${resourceType}`,
    status: "active",
    data: {},
  };
  const payload = JSON.stringify({ actor, event: "system.integration_sync", record, depth: 0, mode: "integration_sync", integration: descriptor });
  if (Buffer.byteLength(payload, "utf8") > 131072) throw new IntegrationSyncValidationError("Payload de synchronisation trop volumineux.");

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO integration_sync_runs
       (id,tenant_id,connection_id,resource_type,direction,trigger_kind,status,job_id,correlation_id,cursor_before,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9,CURRENT_TIMESTAMP)`,
      [runId, actor.tenantId, connection.id, resourceType, direction, triggerKind, jobId, correlationId, cursor],
    );
    await client.query(
      `INSERT INTO automation_jobs(id,tenant_id,event,payload,correlation_id,idempotency_key,status,available_at)
       VALUES ($1,$2,'system.integration_sync',$3,$4,$5,'pending',CURRENT_TIMESTAMP)`,
      [jobId, actor.tenantId, payload, correlationId, `integration_sync:${runId}`],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }

  await audit(actor, {
    action: "integration.sync_requested",
    resourceType: "integration_sync_run",
    resourceId: runId,
    result: "success",
    details: { connectionId: connection.id, resourceType, direction, triggerKind, correlationId, jobId },
  });
  return { runId, jobId, correlationId, status: "queued" as const };
}

export async function executeIntegrationSyncJob(
  actor: AuthContext,
  descriptor: IntegrationSyncDescriptor,
  context: { jobId: string; correlationId: string; attempt: number; maxAttempts: number },
) {
  const connection = await getIntegrationConnection(actor, descriptor.connectionId);
  const connector = getIntegrationConnector(connection.provider);
  const run = await getRun(actor.tenantId, descriptor.runId, descriptor.connectionId);
  if (run.status === "success" || run.status === "partial") return;
  if (["disabled", "revoked"].includes(connection.status)) {
    await failRun(run.id, "connection_inactive", "Connexion inactive.", false, context.attempt, actor.tenantId);
    throw new IntegrationJobError("Connexion inactive.", { retryable: false });
  }

  await getPool().query(
    `UPDATE integration_sync_runs SET status='running',job_id=$1,started_at=COALESCE(started_at,CURRENT_TIMESTAMP),retry_count=GREATEST(0,$2-1),error_code='',error_message=''
     WHERE tenant_id=$3 AND id=$4`,
    [context.jobId, context.attempt, actor.tenantId, run.id],
  );

  try {
    const runtime = await buildRuntimeContext(connection, context.correlationId, true);
    let failed = 0;
    if (descriptor.direction === "pull") {
      if (!connector.pull) throw new ConnectorError("Lecture non prise en charge.", { code: "pull_unsupported" });
      const result = await executePull(actor, connection, descriptor, connector.pull.bind(connector), runtime, run.cursorBefore, context.correlationId);
      failed = result.failed;
    } else {
      throw new ConnectorError("Push générique requiert une ressource explicitement sélectionnée.", { code: "push_payload_required" });
    }
    await getPool().query(
      `UPDATE integration_sync_runs SET status=$1,finished_at=CURRENT_TIMESTAMP,error_code='',error_message=''
       WHERE tenant_id=$2 AND id=$3`, [failed > 0 ? "partial" : "success", actor.tenantId, run.id],
    );
    await getPool().query(
      `UPDATE integration_connections SET status='connected',last_success_at=CURRENT_TIMESTAMP,last_error_code='',last_error_message='',updated_at=CURRENT_TIMESTAMP
       WHERE tenant_id=$1 AND id=$2`, [actor.tenantId, connection.id],
    );
  } catch (error) {
    const normalized = connector.normalizeError(error);
    const retryable = normalized.retryable && context.attempt < context.maxAttempts;
    await failRun(run.id, normalized.code, normalized.message, retryable, context.attempt, actor.tenantId);
    await applyFailure(connection, normalized, context.correlationId);
    throw new IntegrationJobError(normalized.message, {
      retryable,
      retryAfterSeconds: normalized.retryAfterSeconds,
    });
  }
}

async function executePull(
  actor: AuthContext,
  connection: IntegrationConnectionView,
  descriptor: IntegrationSyncDescriptor,
  pull: NonNullable<ReturnType<typeof getIntegrationConnector>["pull"]>,
  runtime: Awaited<ReturnType<typeof buildRuntimeContext>>,
  initialCursor: string,
  correlationId: string,
) {
  let requestCursor = initialCursor || undefined;
  let durableCursor = initialCursor;
  let pageCount = 0;
  let failedTotal = 0;
  const maxPages = envInteger("CLARITY_INTEGRATION_MAX_PAGES_PER_JOB", 100, 1, 1000);
  const seenExternalIds = new Set<string>();

  while (true) {
    if (++pageCount > maxPages) throw new ConnectorError("Limite de pages de synchronisation atteinte.", { code: "page_limit", retryable: true });
    const page = await pull(runtime, descriptor.resourceType, requestCursor);
    if (!Array.isArray(page.items)) throw new ConnectorError("Page fournisseur invalide.", { code: "invalid_provider_page" });
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    for (const item of page.items) {
      validatePullItem(item.externalId);
      if (seenExternalIds.has(item.externalId)) { skipped += 1; continue; }
      seenExternalIds.add(item.externalId);
      const existing = await getPool().query(
        `SELECT id,external_version,external_etag,clarity_kind,clarity_id FROM integration_resource_links
         WHERE tenant_id=$1 AND connection_id=$2 AND resource_type=$3 AND external_id=$4 LIMIT 1`,
        [connection.tenantId, connection.id, descriptor.resourceType, item.externalId],
      );
      const row = existing.rows[0] as Record<string, unknown> | undefined;
      if (row
        && String(row.external_version ?? "") === String(item.externalVersion ?? "")
        && String(row.external_etag ?? "") === String(item.etag ?? "")) {
        skipped += 1;
        await touchResourceLink(connection, descriptor.resourceType, item.externalId, item.deleted === true);
        continue;
      }
      const existingTarget: ExistingIntegrationTarget = row
        ? { kind: String(row.clarity_kind), id: String(row.clarity_id) }
        : null;
      try {
        const target = await normalizeIntegrationPullItem(actor, connection, descriptor.resourceType, item, existingTarget);
        if (!target) {
          skipped += 1;
          continue;
        }
        await upsertIntegrationResourceLink({
          tenantId: connection.tenantId,
          connectionId: connection.id,
          resourceType: descriptor.resourceType,
          externalId: item.externalId,
          clarityKind: target.kind,
          clarityId: target.id,
          externalVersion: item.externalVersion ?? "",
          externalEtag: item.etag ?? "",
          externalDeleted: item.deleted === true,
        });
        if (target.created) created += 1; else updated += 1;
      } catch (error) {
        if (!(error instanceof IntegrationNormalizationError)) throw error;
        failed += 1;
        failedTotal += 1;
        await recordNormalizationFailure(connection, descriptor.resourceType, error, correlationId);
      }
    }

    if (page.checkpointCursor !== undefined) {
      if (typeof page.checkpointCursor !== "string" || page.checkpointCursor.length > 65536) {
        throw new ConnectorError("Checkpoint fournisseur invalide.", { code: "invalid_checkpoint" });
      }
      durableCursor = page.checkpointCursor;
    }
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE integration_sync_runs SET received=received+$1,created_count=created_count+$2,updated_count=updated_count+$3,
         skipped_count=skipped_count+$4,failed_count=failed_count+$5,cursor_after=$6 WHERE tenant_id=$7 AND id=$8`,
        [page.items.length, created, updated, skipped, failed, durableCursor, connection.tenantId, descriptor.runId],
      );
      if (page.checkpointCursor !== undefined) {
        await client.query(
          `INSERT INTO integration_sync_cursors(id,tenant_id,connection_id,resource_type,direction,cursor_value,watermark_at)
           VALUES ($1,$2,$3,$4,'pull',$5,CURRENT_TIMESTAMP)
           ON CONFLICT(tenant_id,connection_id,resource_type,direction) DO UPDATE SET
             cursor_value=excluded.cursor_value,cursor_version=integration_sync_cursors.cursor_version+1,watermark_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP`,
          [crypto.randomUUID(), connection.tenantId, connection.id, descriptor.resourceType, durableCursor],
        );
      }
      if (page.quota) {
        const retryAfter = boundedOptionalInteger(page.quota.retryAfterSeconds, 0, 86400);
        const remaining = boundedOptionalInteger(page.quota.remaining, 0, 2_147_483_647);
        const bucket = String(page.quota.bucket ?? "default").slice(0, 120) || "default";
        await client.query(
          `INSERT INTO integration_rate_limits(id,tenant_id,connection_id,provider_bucket,blocked_until,retry_after_seconds,remaining,observed_at)
           VALUES ($1,$2,$3,$4,CASE WHEN $5::int IS NULL THEN NULL ELSE CURRENT_TIMESTAMP + ($5 * INTERVAL '1 second') END,$5,$6,CURRENT_TIMESTAMP)
           ON CONFLICT(tenant_id,connection_id,provider_bucket) DO UPDATE SET
             blocked_until=excluded.blocked_until,retry_after_seconds=excluded.retry_after_seconds,remaining=excluded.remaining,observed_at=CURRENT_TIMESTAMP`,
          [crypto.randomUUID(), connection.tenantId, connection.id, bucket, retryAfter, remaining],
        );
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }

    if (!page.hasMore) break;
    requestCursor = page.continuationCursor;
    if (!requestCursor || requestCursor.length > 65536) {
      throw new ConnectorError("Curseur de pagination fournisseur absent ou invalide.", { code: "missing_continuation_cursor" });
    }
  }
  return { failed: failedTotal };
}

export async function upsertIntegrationResourceLink(input: {
  tenantId: string;
  connectionId: string;
  resourceType: string;
  externalId: string;
  clarityKind: string;
  clarityId: string;
  externalVersion?: string;
  externalEtag?: string;
  externalDeleted?: boolean;
}) {
  validatePullItem(input.externalId);
  if (!RESOURCE_RE.test(input.clarityKind) || !input.clarityId || input.clarityId.length > 240) throw new IntegrationSyncValidationError("Cible Clarity invalide.");
  await getPool().query(
    `INSERT INTO integration_resource_links
     (id,tenant_id,connection_id,resource_type,external_id,clarity_kind,clarity_id,external_version,external_etag,origin,external_deleted_at,last_synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'integration',CASE WHEN $10::boolean THEN CURRENT_TIMESTAMP ELSE NULL END,CURRENT_TIMESTAMP)
     ON CONFLICT(tenant_id,connection_id,resource_type,external_id) DO UPDATE SET
       clarity_kind=excluded.clarity_kind,clarity_id=excluded.clarity_id,external_version=excluded.external_version,
       external_etag=excluded.external_etag,external_deleted_at=excluded.external_deleted_at,last_synced_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP`,
    [crypto.randomUUID(), input.tenantId, input.connectionId, input.resourceType, input.externalId, input.clarityKind, input.clarityId,
      input.externalVersion ?? "", input.externalEtag ?? "", input.externalDeleted === true],
  );
}

export async function getIntegrationSyncRun(actor: AuthContext, runId: string) {
  await requireIntegrationSyncPermission(actor);
  return getRun(actor.tenantId, runId);
}

export function integrationSyncErrorResponse(error: unknown) {
  if (error instanceof IntegrationSyncValidationError) return Response.json({ error: error.message }, { status: error.status });
  return null;
}

async function getRun(tenantId: string, runId: string, connectionId?: string) {
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(runId)) throw new IntegrationSyncValidationError("Run invalide.");
  const params: unknown[] = [tenantId, runId];
  let sql = `SELECT * FROM integration_sync_runs WHERE tenant_id=$1 AND id=$2`;
  if (connectionId) { params.push(connectionId); sql += ` AND connection_id=$3`; }
  sql += ` LIMIT 1`;
  const result = await getPool().query(sql, params);
  if (!result.rows[0]) throw new IntegrationSyncValidationError("Run introuvable.", 404);
  const row = result.rows[0];
  return {
    id: String(row.id), connectionId: String(row.connection_id), resourceType: String(row.resource_type), direction: String(row.direction),
    triggerKind: String(row.trigger_kind), status: String(row.status), jobId: row.job_id ? String(row.job_id) : null, correlationId: String(row.correlation_id),
    cursorBefore: String(row.cursor_before ?? ""), cursorAfter: String(row.cursor_after ?? ""), received: Number(row.received ?? 0),
    created: Number(row.created_count ?? 0), updated: Number(row.updated_count ?? 0), skipped: Number(row.skipped_count ?? 0), failed: Number(row.failed_count ?? 0),
    retryCount: Number(row.retry_count ?? 0), errorCode: String(row.error_code ?? ""), errorMessage: String(row.error_message ?? ""),
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null, finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function getCursor(connection: IntegrationConnectionView, resourceType: string, direction: string) {
  const result = await getPool().query(
    `SELECT cursor_value FROM integration_sync_cursors WHERE tenant_id=$1 AND connection_id=$2 AND resource_type=$3 AND direction=$4 LIMIT 1`,
    [connection.tenantId, connection.id, resourceType, direction],
  );
  return String(result.rows[0]?.cursor_value ?? "");
}

async function touchResourceLink(connection: IntegrationConnectionView, resourceType: string, externalId: string, deleted: boolean) {
  await getPool().query(
    `UPDATE integration_resource_links SET last_synced_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,
     external_deleted_at=CASE WHEN $1::boolean THEN COALESCE(external_deleted_at,CURRENT_TIMESTAMP) ELSE external_deleted_at END
     WHERE tenant_id=$2 AND connection_id=$3 AND resource_type=$4 AND external_id=$5`,
    [deleted, connection.tenantId, connection.id, resourceType, externalId],
  );
}

async function recordNormalizationFailure(
  connection: IntegrationConnectionView,
  resourceType: string,
  error: IntegrationNormalizationError,
  correlationId: string,
) {
  await getPool().query(
    `INSERT INTO integration_health_events(id,tenant_id,connection_id,severity,code,message,details,correlation_id)
     VALUES ($1,$2,$3,'warning','normalization_failed',$4,$5::jsonb,$6)`,
    [crypto.randomUUID(), connection.tenantId, connection.id, error.message.slice(0, 2000), JSON.stringify({ resourceType }), correlationId.slice(0, 120)],
  );
}

async function failRun(runId: string, code: string, message: string, retryable: boolean, attempt: number, tenantId?: string) {
  const params: unknown[] = [retryable ? "retrying" : "failed", code.slice(0, 120), message.slice(0, 2000), attempt, runId];
  let sql = `UPDATE integration_sync_runs SET status=$1,error_code=$2,error_message=$3,retry_count=GREATEST(0,$4-1),`;
  sql += retryable ? `finished_at=NULL` : `finished_at=CURRENT_TIMESTAMP`;
  sql += ` WHERE id=$5`;
  if (tenantId) { params.push(tenantId); sql += ` AND tenant_id=$6`; }
  await getPool().query(sql, params);
}

async function applyFailure(connection: IntegrationConnectionView, error: ConnectorError, correlationId: string) {
  const status = error.authRequired ? "reauth_required" : error.rateLimited ? "rate_limited" : error.retryable ? "degraded" : "error";
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE integration_connections SET status=$1,last_error_code=$2,last_error_message=$3,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=$4 AND id=$5`,
      [status, error.code.slice(0, 120), error.message.slice(0, 2000), connection.tenantId, connection.id],
    );
    await client.query(
      `INSERT INTO integration_health_events(id,tenant_id,connection_id,severity,code,message,details,correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [crypto.randomUUID(), connection.tenantId, connection.id, error.rateLimited ? "warning" : "error", safeCode(error.code), error.message.slice(0, 2000),
        JSON.stringify({ retryable: error.retryable, retryAfterSeconds: error.retryAfterSeconds }), correlationId.slice(0, 120)],
    );
    if (error.rateLimited) {
      const retryAfter = boundedOptionalInteger(error.retryAfterSeconds, 0, 86400) ?? 60;
      await client.query(
        `INSERT INTO integration_rate_limits(id,tenant_id,connection_id,provider_bucket,blocked_until,retry_after_seconds,observed_at)
         VALUES ($1,$2,$3,'default',CURRENT_TIMESTAMP + ($4 * INTERVAL '1 second'),$4,CURRENT_TIMESTAMP)
         ON CONFLICT(tenant_id,connection_id,provider_bucket) DO UPDATE SET blocked_until=excluded.blocked_until,retry_after_seconds=excluded.retry_after_seconds,observed_at=CURRENT_TIMESTAMP`,
        [crypto.randomUUID(), connection.tenantId, connection.id, retryAfter],
      );
    }
    await client.query("COMMIT");
  } catch (failure) { await client.query("ROLLBACK"); throw failure; } finally { client.release(); }
}

function normalizeResourceType(value: string) { const resource = String(value ?? "").trim(); if (!RESOURCE_RE.test(resource)) throw new IntegrationSyncValidationError("Type de ressource invalide."); return resource; }
function validatePullItem(value: string) { if (typeof value !== "string" || value.length < 1 || value.length > 1024 || /[\r\n\0]/.test(value)) throw new ConnectorError("Identifiant fournisseur invalide.", { code: "invalid_external_id" }); }
function boundedOptionalInteger(value: unknown, min: number, max: number) { if (value === undefined || value === null) return null; const n = Number(value); return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : null; }
function envInteger(name: string, fallback: number, minimum: number, maximum: number) { const value = Number(process.env[name]); return Number.isInteger(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback; }
function safeCode(value: string) { return String(value || "integration_error").replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 120) || "integration_error"; }

export class IntegrationSyncValidationError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.name = "IntegrationSyncValidationError"; this.status = status; }
}
export class IntegrationJobError extends Error {
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  constructor(message: string, options: { retryable: boolean; retryAfterSeconds?: number }) {
    super(message);
    this.name = "IntegrationJobError";
    this.retryable = options.retryable;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

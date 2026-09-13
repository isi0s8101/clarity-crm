import { getPool } from "@/db";
import { audit, type AuthContext, type AuthRole } from "@/lib/authz";
import {
  assertIntegrationMappingAllows,
  loadIntegrationMapping,
} from "@/lib/integration-mappings";

const RESOURCE_RE = /^[a-z][a-z0-9._:-]{0,79}$/;

export async function enqueueDueIntegrationSyncJobs(limit = 20) {
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const candidates = await getPool().query(
    `SELECT c.id,c.tenant_id,c.name,c.owner_admin_id,c.capabilities,c.sync_policy,
            u.email,u.display_name,m.role,
            COALESCE(m.team_id,(SELECT t.id FROM teams t WHERE t.tenant_id=c.tenant_id ORDER BY t.created_at LIMIT 1),'') AS team_id
     FROM integration_connections c
     JOIN users u ON u.id=c.owner_admin_id
     JOIN memberships m ON m.tenant_id=c.tenant_id AND m.user_id=c.owner_admin_id AND m.status='active'
     WHERE c.status IN ('connected','degraded')
     ORDER BY c.updated_at ASC
     LIMIT $1`,
    [Math.min(500, boundedLimit * 10)],
  );
  let queued = 0;
  for (const row of candidates.rows) {
    if (queued >= boundedLimit) break;
    const actor = actorFromRow(row as Record<string, unknown>);
    if (!actor || actor.role !== "admin") continue;
    const policy = asObject(row.sync_policy);
    if (policy.enabled !== true) continue;
    const intervalMinutes = boundedInteger(policy.intervalMinutes, 15, 5, 10080);
    const resources = scheduledResources(policy.resources, row.capabilities);
    for (const resourceType of resources) {
      if (queued >= boundedLimit) break;
      const mapping = await loadIntegrationMapping(actor.tenantId, String(row.id), resourceType);
      try { assertIntegrationMappingAllows(mapping, "pull"); } catch { continue; }
      if (await connectionIsRateLimited(actor.tenantId, String(row.id))) continue;
      if (!(await isResourceDue(actor.tenantId, String(row.id), resourceType, intervalMinutes))) continue;
      if (await hasActiveRun(actor.tenantId, String(row.id), resourceType)) continue;
      if (await enqueueScheduledRun(actor, String(row.id), String(row.name), resourceType, intervalMinutes)) queued += 1;
    }
  }
  return queued;
}

async function enqueueScheduledRun(
  actor: AuthContext,
  connectionId: string,
  connectionName: string,
  resourceType: string,
  intervalMinutes: number,
) {
  const runId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const correlationId = crypto.randomUUID();
  const bucket = Math.floor(Date.now() / (intervalMinutes * 60_000));
  const idempotencyKey = `integration_scheduled:${connectionId}:${resourceType}:${bucket}`.slice(0, 240);
  const cursorResult = await getPool().query(
    `SELECT cursor_value FROM integration_sync_cursors
     WHERE tenant_id=$1 AND connection_id=$2 AND resource_type=$3 AND direction='pull' LIMIT 1`,
    [actor.tenantId, connectionId, resourceType],
  );
  const cursor = String(cursorResult.rows[0]?.cursor_value ?? "");
  const integration = { runId, connectionId, resourceType, direction: "pull" as const };
  const record = {
    id: `integration:${connectionId}:${resourceType}`,
    tenantId: actor.tenantId,
    teamId: actor.teamId,
    ownerId: actor.userId,
    type: "integration",
    title: `${connectionName} — ${resourceType}`,
    status: "active",
    data: {},
  };
  const payload = JSON.stringify({ actor, event: "system.integration_sync", record, depth: 0, mode: "integration_sync", integration });
  if (Buffer.byteLength(payload, "utf8") > 131072) return false;

  const client = await getPool().connect();
  let inserted = false;
  try {
    await client.query("BEGIN");
    const job = await client.query(
      `INSERT INTO automation_jobs(id,tenant_id,event,payload,correlation_id,idempotency_key,status,available_at)
       VALUES ($1,$2,'system.integration_sync',$3,$4,$5,'pending',CURRENT_TIMESTAMP)
       ON CONFLICT(tenant_id,idempotency_key) DO NOTHING RETURNING id`,
      [jobId, actor.tenantId, payload, correlationId, idempotencyKey],
    );
    if (!job.rows[0]) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `INSERT INTO integration_sync_runs
       (id,tenant_id,connection_id,resource_type,direction,trigger_kind,status,job_id,correlation_id,cursor_before,created_at)
       VALUES ($1,$2,$3,$4,'pull','scheduled','queued',$5,$6,$7,CURRENT_TIMESTAMP)`,
      [runId, actor.tenantId, connectionId, resourceType, jobId, correlationId, cursor],
    );
    await client.query("COMMIT");
    inserted = true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }

  if (inserted) {
    await audit(actor, {
      action: "integration.sync_scheduled",
      resourceType: "integration_sync_run",
      resourceId: runId,
      result: "success",
      details: { connectionId, resourceType, correlationId, jobId, intervalMinutes },
    });
  }
  return inserted;
}

async function isResourceDue(tenantId: string, connectionId: string, resourceType: string, intervalMinutes: number) {
  const result = await getPool().query(
    `SELECT created_at FROM integration_sync_runs
     WHERE tenant_id=$1 AND connection_id=$2 AND resource_type=$3 AND direction='pull'
     ORDER BY created_at DESC LIMIT 1`,
    [tenantId, connectionId, resourceType],
  );
  if (!result.rows[0]) return true;
  const last = new Date(result.rows[0].created_at as string | Date).getTime();
  return !Number.isFinite(last) || last <= Date.now() - intervalMinutes * 60_000;
}

async function hasActiveRun(tenantId: string, connectionId: string, resourceType: string) {
  const result = await getPool().query(
    `SELECT 1 FROM integration_sync_runs
     WHERE tenant_id=$1 AND connection_id=$2 AND resource_type=$3 AND direction='pull'
       AND status IN ('queued','running','retrying') LIMIT 1`,
    [tenantId, connectionId, resourceType],
  );
  return Boolean(result.rows[0]);
}

async function connectionIsRateLimited(tenantId: string, connectionId: string) {
  const result = await getPool().query(
    `SELECT 1 FROM integration_rate_limits
     WHERE tenant_id=$1 AND connection_id=$2 AND blocked_until>CURRENT_TIMESTAMP LIMIT 1`,
    [tenantId, connectionId],
  );
  return Boolean(result.rows[0]);
}

function scheduledResources(value: unknown, capabilities: unknown) {
  const explicit = Array.isArray(value) ? value.map(String) : [];
  const resources = explicit.length ? explicit : inferResources(capabilities);
  return [...new Set(resources.map((item) => item.trim()).filter((item) => RESOURCE_RE.test(item)))].slice(0, 16);
}
function inferResources(capabilities: unknown) {
  const values = Array.isArray(capabilities) ? capabilities.map(String) : [];
  const result: string[] = [];
  if (values.includes("mail.read")) result.push("mail");
  if (values.includes("calendar.read")) result.push("calendar");
  if (values.includes("contacts.read")) result.push("contacts");
  if (values.includes("files.read")) result.push("files");
  if (values.includes("directory.users.read")) result.push("directory.users");
  if (values.includes("directory.groups.read")) result.push("directory.groups");
  return result;
}
function actorFromRow(row: Record<string, unknown>): AuthContext | null {
  const teamId = String(row.team_id ?? "");
  const role = String(row.role ?? "") as AuthRole;
  if (!teamId || (role !== "admin" && role !== "user" && role !== "client")) return null;
  return {
    userId: String(row.owner_admin_id),
    email: String(row.email),
    displayName: String(row.display_name),
    tenantId: String(row.tenant_id),
    teamId,
    role,
  };
}
function asObject(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function boundedInteger(value: unknown, fallback: number, min: number, max: number) { const parsed = Number(value); return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback; }

import { getPool } from "@/db";
import { audit, type AuthContext } from "@/lib/authz";
import {
  getIntegrationConnection,
  requireIntegrationSyncPermission,
} from "@/lib/integration-manager";

const RESOURCE_RE = /^[a-z][a-z0-9._:-]{0,79}$/;
const TYPE_RE = /^[a-z][a-z0-9_-]{0,49}$/;
const DIRECTIONS = new Set(["pull_only", "push_only", "bidirectional"]);
const CONFLICT_POLICIES = new Set(["manual", "external_wins", "clarity_wins"]);
const DENIED_KEY_RE = /(?:^|[_-])(token|secret|password|authorization|credential|cookie|private[_-]?key)(?:$|[_-])/i;
const MAX_MAPPING_BYTES = 64 * 1024;

export type IntegrationMappingView = {
  id: string;
  tenantId: string;
  connectionId: string;
  resourceType: string;
  direction: "pull_only" | "push_only" | "bidirectional";
  clarityType: string;
  conflictPolicy: "manual" | "external_wins" | "clarity_wins";
  mapping: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export async function listIntegrationMappings(actor: AuthContext, connectionId: string) {
  const connection = await getIntegrationConnection(actor, connectionId);
  const result = await getPool().query(
    `SELECT * FROM integration_mappings WHERE tenant_id=$1 AND connection_id=$2 ORDER BY resource_type`,
    [actor.tenantId, connection.id],
  );
  return result.rows.map(decodeMapping);
}

export async function saveIntegrationMapping(actor: AuthContext, connectionId: string, input: {
  resourceType: string;
  direction?: string;
  clarityType?: string;
  conflictPolicy?: string;
  mapping?: Record<string, unknown>;
  enabled?: boolean;
}) {
  await requireIntegrationSyncPermission(actor);
  const connection = await getIntegrationConnection(actor, connectionId);
  const resourceType = normalizeResourceType(input.resourceType);
  const direction = normalizeDirection(input.direction ?? "pull_only");
  const clarityType = normalizeClarityType(input.clarityType ?? defaultClarityType(resourceType));
  const conflictPolicy = normalizeConflictPolicy(input.conflictPolicy ?? "external_wins");
  const mapping = normalizeMapping(input.mapping);
  const enabled = input.enabled !== false;
  const id = `${connection.id}:${resourceType}`.slice(0, 240);
  const previous = await loadIntegrationMapping(actor.tenantId, connection.id, resourceType);

  await getPool().query(
    `INSERT INTO integration_mappings
     (id,tenant_id,connection_id,resource_type,direction,clarity_type,conflict_policy,mapping,enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
     ON CONFLICT(tenant_id,connection_id,resource_type) DO UPDATE SET
       direction=excluded.direction,clarity_type=excluded.clarity_type,conflict_policy=excluded.conflict_policy,
       mapping=excluded.mapping,enabled=excluded.enabled,updated_at=CURRENT_TIMESTAMP`,
    [id, actor.tenantId, connection.id, resourceType, direction, clarityType, conflictPolicy, JSON.stringify(mapping), enabled],
  );
  const current = await loadIntegrationMapping(actor.tenantId, connection.id, resourceType);
  await audit(actor, {
    action: previous ? "integration.mapping_updated" : "integration.mapping_created",
    resourceType: "integration_mapping",
    resourceId: id,
    result: "success",
    before: previous ?? undefined,
    after: current ?? undefined,
    details: { connectionId: connection.id, provider: connection.provider, resourceType },
  });
  return current;
}

export async function removeIntegrationMapping(actor: AuthContext, connectionId: string, resourceTypeInput: string) {
  await requireIntegrationSyncPermission(actor);
  const connection = await getIntegrationConnection(actor, connectionId);
  const resourceType = normalizeResourceType(resourceTypeInput);
  const previous = await loadIntegrationMapping(actor.tenantId, connection.id, resourceType);
  if (!previous) throw new IntegrationMappingError("Mapping introuvable.", 404);
  await getPool().query(
    `DELETE FROM integration_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource_type=$3`,
    [actor.tenantId, connection.id, resourceType],
  );
  await audit(actor, {
    action: "integration.mapping_deleted",
    resourceType: "integration_mapping",
    resourceId: previous.id,
    result: "success",
    before: previous,
    details: { connectionId: connection.id, resourceType },
  });
  return { deleted: true };
}

export async function resetIntegrationCheckpoint(actor: AuthContext, connectionId: string, resourceTypeInput: string) {
  await requireIntegrationSyncPermission(actor);
  const connection = await getIntegrationConnection(actor, connectionId);
  const resourceType = normalizeResourceType(resourceTypeInput);
  const result = await getPool().query(
    `DELETE FROM integration_sync_cursors
     WHERE tenant_id=$1 AND connection_id=$2 AND resource_type=$3 AND direction='pull'
     RETURNING cursor_value,cursor_version`,
    [actor.tenantId, connection.id, resourceType],
  );
  await audit(actor, {
    action: "integration.checkpoint_reset",
    resourceType: "integration_connection",
    resourceId: connection.id,
    result: "success",
    details: { resourceType, hadCheckpoint: Boolean(result.rows[0]), previousCursorVersion: Number(result.rows[0]?.cursor_version ?? 0) },
  });
  return { reset: true, resourceType, hadCheckpoint: Boolean(result.rows[0]) };
}

export async function loadIntegrationMapping(tenantId: string, connectionId: string, resourceTypeInput: string): Promise<IntegrationMappingView | null> {
  const resourceType = normalizeResourceType(resourceTypeInput);
  const result = await getPool().query(
    `SELECT * FROM integration_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource_type=$3 LIMIT 1`,
    [tenantId, connectionId, resourceType],
  );
  return result.rows[0] ? decodeMapping(result.rows[0]) : null;
}

export function assertIntegrationMappingAllows(mapping: IntegrationMappingView | null, direction: "pull" | "push") {
  if (!mapping) return;
  if (!mapping.enabled) throw new IntegrationMappingError("Mapping désactivé pour cette ressource.", 409);
  if (direction === "pull" && mapping.direction === "push_only") throw new IntegrationMappingError("Ce mapping est configuré en écriture uniquement.", 409);
  if (direction === "push" && mapping.direction === "pull_only") throw new IntegrationMappingError("Ce mapping est configuré en lecture uniquement.", 409);
}

export function integrationMappingErrorResponse(error: unknown) {
  if (error instanceof IntegrationMappingError) return Response.json({ error: error.message }, { status: error.status });
  return null;
}

function decodeMapping(row: Record<string, unknown>): IntegrationMappingView {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    connectionId: String(row.connection_id),
    resourceType: normalizeResourceType(String(row.resource_type)),
    direction: normalizeDirection(String(row.direction)),
    clarityType: normalizeClarityType(String(row.clarity_type ?? "")),
    conflictPolicy: normalizeConflictPolicy(String(row.conflict_policy)),
    mapping: asObject(row.mapping),
    enabled: row.enabled === true,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
  };
}

function normalizeResourceType(value: string) {
  const resource = String(value ?? "").trim();
  if (!RESOURCE_RE.test(resource)) throw new IntegrationMappingError("Type de ressource invalide.");
  return resource;
}
function normalizeDirection(value: string): IntegrationMappingView["direction"] {
  if (!DIRECTIONS.has(value)) throw new IntegrationMappingError("Direction de mapping invalide.");
  return value as IntegrationMappingView["direction"];
}
function normalizeConflictPolicy(value: string): IntegrationMappingView["conflictPolicy"] {
  if (!CONFLICT_POLICIES.has(value)) throw new IntegrationMappingError("Politique de conflit invalide.");
  return value as IntegrationMappingView["conflictPolicy"];
}
function normalizeClarityType(value: string) {
  const type = String(value ?? "").trim();
  if (type && !TYPE_RE.test(type)) throw new IntegrationMappingError("Type Clarity invalide.");
  return type;
}
function normalizeMapping(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new IntegrationMappingError("Mapping JSON invalide.");
  rejectSecrets(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_MAPPING_BYTES) throw new IntegrationMappingError("Mapping trop volumineux.");
  return structuredClone(value) as Record<string, unknown>;
}
function rejectSecrets(value: unknown, depth: number) {
  if (depth > 12) throw new IntegrationMappingError("Mapping trop imbriqué.");
  if (Array.isArray(value)) { for (const item of value) rejectSecrets(item, depth + 1); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (DENIED_KEY_RE.test(key)) throw new IntegrationMappingError("Un secret ne doit pas être stocké dans un mapping.");
    rejectSecrets(item, depth + 1);
  }
}
function defaultClarityType(resourceType: string) {
  if (resourceType === "contacts") return "contact";
  if (resourceType === "calendar") return "appointment";
  if (resourceType === "files") return "document";
  if (resourceType === "mail") return "inbox_message";
  return "";
}
function asObject(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

export class IntegrationMappingError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "IntegrationMappingError";
    this.status = status;
  }
}

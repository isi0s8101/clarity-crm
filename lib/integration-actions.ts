import { audit, type AuthContext } from "@/lib/authz";
import {
  buildRuntimeContext,
  getIntegrationConnection,
  requireIntegrationSyncPermission,
} from "@/lib/integration-manager";
import { ConnectorError } from "@/lib/integrations/connector";
import { getIntegrationConnector } from "@/lib/integrations/registry";

const RESOURCE_RE = /^[a-z][a-z0-9._:-]{0,79}$/;
const DENIED_KEY_RE = /(?:^|[_-])(token|secret|password|authorization|credential|cookie|private[_-]?key)(?:$|[_-])/i;
const MAX_PAYLOAD_BYTES = 64 * 1024;

export async function dispatchIntegrationAction(actor: AuthContext, connectionId: string, input: {
  resourceType: string;
  data: Record<string, unknown>;
}) {
  await requireIntegrationSyncPermission(actor);
  const connection = await getIntegrationConnection(actor, connectionId);
  if (["disabled", "revoked", "draft", "connecting"].includes(connection.status)) {
    throw new IntegrationActionError("Connexion non disponible.", 409);
  }
  const resourceType = normalizeResourceType(input.resourceType);
  const data = normalizePayload(input.data);
  const connector = getIntegrationConnector(connection.provider);
  if (!connector.push) throw new IntegrationActionError("Action sortante non prise en charge par ce connecteur.", 409);
  const correlationId = crypto.randomUUID();
  const runtime = await buildRuntimeContext(connection, correlationId, true);
  try {
    const result = await connector.push(runtime, resourceType, data);
    await audit(actor, {
      action: "integration.action_dispatched",
      resourceType: "integration_connection",
      resourceId: connection.id,
      result: "success",
      details: { provider: connection.provider, resourceType, correlationId, externalId: result.externalId },
    });
    return { ...result, correlationId };
  } catch (error) {
    const normalized = connector.normalizeError(error);
    await audit(actor, {
      action: "integration.action_dispatched",
      resourceType: "integration_connection",
      resourceId: connection.id,
      result: "failure",
      details: { provider: connection.provider, resourceType, correlationId, code: normalized.code },
    });
    throw normalized;
  }
}

export function integrationActionErrorResponse(error: unknown) {
  if (error instanceof IntegrationActionError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof ConnectorError) {
    const status = error.authRequired ? 401 : error.rateLimited ? 429 : error.retryable ? 503 : 400;
    return Response.json({ error: error.message, code: error.code }, { status });
  }
  return null;
}

function normalizeResourceType(value: string) {
  const resource = String(value ?? "").trim();
  if (!RESOURCE_RE.test(resource)) throw new IntegrationActionError("Type de ressource invalide.");
  return resource;
}
function normalizePayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new IntegrationActionError("Payload invalide.");
  rejectSecrets(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_PAYLOAD_BYTES) throw new IntegrationActionError("Payload trop volumineux.");
  return structuredClone(value) as Record<string, unknown>;
}
function rejectSecrets(value: unknown, depth: number) {
  if (depth > 12) throw new IntegrationActionError("Payload trop imbriqué.");
  if (Array.isArray(value)) { for (const item of value) rejectSecrets(item, depth + 1); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (DENIED_KEY_RE.test(key)) throw new IntegrationActionError("Le payload ne doit pas contenir de secret.");
    rejectSecrets(item, depth + 1);
  }
}

export class IntegrationActionError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "IntegrationActionError";
    this.status = status;
  }
}

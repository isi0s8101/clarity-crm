import { getPool } from "@/db";
import type { AuthContext } from "@/lib/authz";
import { createCrmRecord, updateCrmRecord } from "@/lib/crm-core";
import type { IntegrationConnectionView } from "@/lib/integration-manager";
import type { PullItem } from "@/lib/integrations/connector";
import { addInboxMessage, createInboxConversation } from "@/lib/v12-inbox";

export type ExistingIntegrationTarget = {
  kind: string;
  id: string;
} | null;

export type IntegrationNormalizationResult = {
  kind: string;
  id: string;
  created: boolean;
};

const PROVIDERS = new Set(["google", "microsoft"]);

export async function normalizeIntegrationPullItem(
  actor: AuthContext,
  connection: IntegrationConnectionView,
  resourceType: string,
  item: PullItem,
  existingTarget: ExistingIntegrationTarget,
): Promise<IntegrationNormalizationResult | null> {
  assertCanonicalProvider(connection, item.data);
  if (item.deleted === true) {
    return existingTarget ? { ...existingTarget, created: false } : null;
  }

  if (resourceType === "contacts" && item.data.kind === "contact") {
    return normalizeContact(actor, connection, item, existingTarget);
  }
  if (resourceType === "calendar" && item.data.kind === "appointment") {
    return normalizeAppointment(actor, connection, item, existingTarget);
  }
  if (resourceType === "files" && item.data.kind === "document") {
    return normalizeDocument(actor, connection, item, existingTarget);
  }
  if (resourceType === "mail" && item.data.kind === "mail") {
    return normalizeMail(actor, connection, item, existingTarget);
  }
  return null;
}

async function normalizeContact(
  actor: AuthContext,
  connection: IntegrationConnectionView,
  item: PullItem,
  existingTarget: ExistingIntegrationTarget,
) {
  const title = cleanText(item.data.title, 160) || "Contact externe";
  const providerData = integrationMetadata(connection, item);
  assignIfText(providerData, "email", item.data.email, 254, true);
  assignIfText(providerData, "phone", item.data.phone, 120);
  assignIfText(providerData, "organization", item.data.organization, 240);
  assignIfText(providerData, "jobTitle", item.data.jobTitle, 240);
  assignIfText(providerData, "address", item.data.address, 2000);

  if (existingTarget) {
    assertTargetKind(existingTarget, "contact");
    const record = await updateCrmRecord(actor, existingTarget.id, { title, data: providerData });
    return { kind: "contact", id: record.id, created: false };
  }
  const record = await createCrmRecord(actor, { type: "contact", title, status: "active", data: providerData });
  return { kind: "contact", id: record.id, created: true };
}

async function normalizeAppointment(
  actor: AuthContext,
  connection: IntegrationConnectionView,
  item: PullItem,
  existingTarget: ExistingIntegrationTarget,
) {
  const startsAt = requiredIsoDate(item.data.startsAt, "Début de rendez-vous fournisseur invalide.");
  const endsAt = requiredIsoDate(item.data.endsAt, "Fin de rendez-vous fournisseur invalide.");
  if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    throw new IntegrationNormalizationError("Intervalle de rendez-vous fournisseur invalide.");
  }
  const title = cleanText(item.data.title, 160) || "Rendez-vous externe";
  const providerData = integrationMetadata(connection, item);
  providerData.startsAt = startsAt;
  providerData.endsAt = endsAt;
  providerData.timezone = cleanText(item.data.timezone, 120) || "UTC";
  assignIfText(providerData, "location", item.data.location, 1000);
  assignIfText(providerData, "description", item.data.description, 20000);
  assignIfText(providerData, "externalUrl", item.data.htmlLink ?? item.data.webLink, 2048);
  assignIfText(providerData, "organizer", item.data.organizer, 1000);

  let recordId: string;
  let created = false;
  if (existingTarget) {
    assertTargetKind(existingTarget, "appointment");
    const record = await updateCrmRecord(actor, existingTarget.id, { title, data: providerData });
    recordId = record.id;
  } else {
    const record = await createCrmRecord(actor, { type: "appointment", title, status: "active", data: providerData });
    recordId = record.id;
    created = true;
  }
  await synchronizePlanningReservation(actor, connection, recordId, startsAt, endsAt, String(providerData.timezone));
  return { kind: "appointment", id: recordId, created };
}

async function normalizeDocument(
  actor: AuthContext,
  connection: IntegrationConnectionView,
  item: PullItem,
  existingTarget: ExistingIntegrationTarget,
) {
  const title = cleanText(item.data.title, 160) || cleanText(item.data.fileName, 160) || "Document externe";
  const providerData = integrationMetadata(connection, item);
  assignIfText(providerData, "fileName", item.data.fileName, 255);
  assignIfText(providerData, "mimeType", item.data.mimeType, 120);
  assignIfText(providerData, "url", item.data.url, 2048);
  assignIfText(providerData, "modifiedAt", item.data.modifiedAt, 128);
  assignIfText(providerData, "checksum", item.data.checksum, 256);
  const sizeBytes = Number(item.data.sizeBytes);
  if (Number.isSafeInteger(sizeBytes) && sizeBytes >= 0) providerData.sizeBytes = sizeBytes;
  providerData.externalLinkOnly = true;

  if (existingTarget) {
    assertTargetKind(existingTarget, "document");
    const record = await updateCrmRecord(actor, existingTarget.id, { title, data: providerData });
    return { kind: "document", id: record.id, created: false };
  }
  const record = await createCrmRecord(actor, { type: "document", title, status: "active", data: providerData });
  return { kind: "document", id: record.id, created: true };
}

async function normalizeMail(
  actor: AuthContext,
  connection: IntegrationConnectionView,
  item: PullItem,
  existingTarget: ExistingIntegrationTarget,
) {
  if (existingTarget) {
    assertTargetKind(existingTarget, "inbox_message");
    return { kind: "inbox_message", id: existingTarget.id, created: false };
  }
  const threadExternalId = cleanText(item.data.threadExternalId, 1024) || item.externalId;
  const conversationId = await getOrCreateMailConversation(actor, connection, threadExternalId, item.data);
  const direction = item.data.direction === "outbound" ? "outbound" : "inbound";
  const metadata: Record<string, unknown> = integrationMetadata(connection, item);
  assignIfText(metadata, "from", item.data.from, 4096);
  assignIfText(metadata, "to", item.data.to, 4096);
  assignIfText(metadata, "cc", item.data.cc, 4096);
  assignIfText(metadata, "internetMessageId", item.data.internetMessageId, 1024);
  assignIfText(metadata, "receivedAt", item.data.receivedAt, 128);
  metadata.threadExternalId = threadExternalId;
  const body = cleanText(item.data.bodyPreview, 65536)
    || cleanText(item.data.subject, 240)
    || "Message externe synchronisé";
  const message = await addInboxMessage(actor, conversationId, {
    body,
    direction,
    senderKind: direction === "inbound" ? "external" : "internal",
    metadata,
  });
  return { kind: "inbox_message", id: message.id, created: true };
}

async function getOrCreateMailConversation(
  actor: AuthContext,
  connection: IntegrationConnectionView,
  threadExternalId: string,
  data: Record<string, unknown>,
) {
  const existing = await getPool().query(
    `SELECT clarity_id FROM integration_resource_links
     WHERE tenant_id=$1 AND connection_id=$2 AND resource_type='mail.thread' AND external_id=$3 LIMIT 1`,
    [actor.tenantId, connection.id, threadExternalId],
  );
  if (existing.rows[0]?.clarity_id) return String(existing.rows[0].clarity_id);

  const conversation = await createInboxConversation(actor, {
    subject: cleanText(data.subject, 240) || "Conversation externe",
    status: "open",
  });
  await getPool().query(
    `INSERT INTO integration_resource_links
     (id,tenant_id,connection_id,resource_type,external_id,clarity_kind,clarity_id,origin,last_synced_at)
     VALUES ($1,$2,$3,'mail.thread',$4,'inbox_conversation',$5,'integration',CURRENT_TIMESTAMP)
     ON CONFLICT(tenant_id,connection_id,resource_type,external_id) DO NOTHING`,
    [crypto.randomUUID(), actor.tenantId, connection.id, threadExternalId, conversation.id],
  );
  const winner = await getPool().query(
    `SELECT clarity_id FROM integration_resource_links
     WHERE tenant_id=$1 AND connection_id=$2 AND resource_type='mail.thread' AND external_id=$3 LIMIT 1`,
    [actor.tenantId, connection.id, threadExternalId],
  );
  return String(winner.rows[0]?.clarity_id ?? conversation.id);
}

async function synchronizePlanningReservation(
  actor: AuthContext,
  connection: IntegrationConnectionView,
  appointmentId: string,
  startsAt: string,
  endsAt: string,
  timezone: string,
) {
  const idempotencyKey = `integration:${connection.id}:${appointmentId}`.slice(0, 240);
  try {
    await getPool().query(
      `INSERT INTO planning_reservations
       (id,tenant_id,appointment_id,resource_kind,resource_id,starts_at,ends_at,blocked_starts_at,blocked_ends_at,timezone,status,idempotency_key,created_by)
       VALUES ($1,$2,$3,'user',$4,$5,$6,$5,$6,$7,'booked',$8,$9)
       ON CONFLICT(tenant_id,appointment_id) DO UPDATE SET
         resource_kind='user',resource_id=excluded.resource_id,starts_at=excluded.starts_at,ends_at=excluded.ends_at,
         blocked_starts_at=excluded.blocked_starts_at,blocked_ends_at=excluded.blocked_ends_at,timezone=excluded.timezone,
         status='booked',updated_at=CURRENT_TIMESTAMP`,
      [crypto.randomUUID(), actor.tenantId, appointmentId, connection.ownerAdminId, startsAt, endsAt, timezone, idempotencyKey, actor.userId],
    );
  } catch (error) {
    if (!isPostgresExclusionViolation(error)) throw error;
    await getPool().query(
      `DELETE FROM planning_reservations WHERE tenant_id=$1 AND appointment_id=$2`,
      [actor.tenantId, appointmentId],
    );
    await getPool().query(
      `INSERT INTO integration_health_events(id,tenant_id,connection_id,severity,code,message,details,correlation_id)
       VALUES ($1,$2,$3,'warning','planning_overlap','Un rendez-vous externe chevauche une réservation Clarity existante.',
         $4::jsonb,'')`,
      [crypto.randomUUID(), actor.tenantId, connection.id, JSON.stringify({ appointmentId, startsAt, endsAt })],
    );
  }
}

function integrationMetadata(connection: IntegrationConnectionView, item: PullItem): Record<string, unknown> {
  return {
    integrationOrigin: true,
    integrationProvider: connection.provider,
    integrationConnectionId: connection.id,
    integrationExternalId: item.externalId,
    ...(item.externalVersion ? { integrationExternalVersion: item.externalVersion } : {}),
    ...(item.etag ? { integrationExternalEtag: item.etag } : {}),
  };
}

function assertCanonicalProvider(connection: IntegrationConnectionView, data: Record<string, unknown>) {
  const provider = typeof data.provider === "string" ? data.provider : "";
  if (!PROVIDERS.has(connection.provider) || provider !== connection.provider) {
    throw new IntegrationNormalizationError("Payload fournisseur incohérent avec la connexion.");
  }
}

function assertTargetKind(target: NonNullable<ExistingIntegrationTarget>, expected: string) {
  if (target.kind !== expected) throw new IntegrationNormalizationError(`Lien d'intégration incohérent: ${target.kind} au lieu de ${expected}.`);
}

function assignIfText(target: Record<string, unknown>, key: string, value: unknown, max: number, lowercase = false) {
  const text = cleanText(value, max);
  if (text) target[key] = lowercase ? text.toLowerCase() : text;
}

function cleanText(value: unknown, max: number) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text || /[\0]/.test(text)) return "";
  return text.slice(0, max);
}

function requiredIsoDate(value: unknown, message: string) {
  if (typeof value !== "string" || !value) throw new IntegrationNormalizationError(message);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new IntegrationNormalizationError(message);
  return date.toISOString();
}

function isPostgresExclusionViolation(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23P01");
}

export class IntegrationNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationNormalizationError";
  }
}

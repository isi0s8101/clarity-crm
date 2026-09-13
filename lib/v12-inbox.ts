import { getPool } from "@/db";
import {
  audit,
  canUseResource,
  requirePermission,
  type AuthContext,
  type PermissionScope,
} from "@/lib/authz";
import { appendTimeline, getCrmRecord } from "@/lib/crm-core";
import { V12NotFoundError, V12ValidationError } from "@/lib/v12-planning";

const ID_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const STATUSES = new Set(["open", "pending", "closed", "archived"]);
const DIRECTIONS = new Set(["inbound", "outbound", "internal"]);
const SENDER_KINDS = new Set(["internal", "external", "system"]);

type ConversationResource = {
  id: string;
  tenantId: string;
  teamId: string;
  ownerId: string;
  assigneeId: string | null;
  relatedRecordId: string | null;
  subject: string;
  status: string;
  unreadCount: number;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function listInboxConversations(actor: AuthContext, input: {
  status?: string | null;
  q?: string | null;
  unread?: boolean;
  relatedRecordId?: string | null;
  limit?: number;
  offset?: number;
}) {
  const scope = await requirePermission(actor, "timeline", "read");
  const params: unknown[] = [actor.tenantId];
  const clauses = ["c.tenant_id=$1"];
  applyScopeFilter(actor, scope, params, clauses, "c");
  if (input.status) {
    const status = normalizeStatus(input.status);
    params.push(status); clauses.push(`c.status=$${params.length}`);
  }
  if (input.unread === true) clauses.push("c.unread_count>0");
  if (input.relatedRecordId) {
    const id = normalizeId(input.relatedRecordId, "Identifiant CRM invalide.");
    params.push(id); clauses.push(`c.related_record_id=$${params.length}`);
  }
  if (input.q?.trim()) {
    params.push(`%${input.q.trim().slice(0, 120)}%`);
    clauses.push(`(c.subject ILIKE $${params.length} OR EXISTS (
      SELECT 1 FROM crm_inbox_messages m WHERE m.tenant_id=c.tenant_id AND m.conversation_id=c.id AND m.body ILIKE $${params.length}
    ))`);
  }
  const limit = boundedInteger(input.limit ?? 50, 1, 100, "Limite invalide.");
  const offset = boundedInteger(input.offset ?? 0, 0, 10000, "Offset invalide.");
  params.push(limit); const limitIndex = params.length;
  params.push(offset); const offsetIndex = params.length;
  const result = await getPool().query(
    `SELECT c.* FROM crm_inbox_conversations c WHERE ${clauses.join(" AND ")}
     ORDER BY COALESCE(c.last_message_at,c.created_at) DESC LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
    params,
  );
  return result.rows.map(decodeConversation);
}

export async function getInboxConversation(actor: AuthContext, conversationId: string) {
  const scope = await requirePermission(actor, "timeline", "read");
  const id = normalizeId(conversationId, "Conversation invalide.");
  const result = await getPool().query(`SELECT * FROM crm_inbox_conversations WHERE tenant_id=$1 AND id=$2 LIMIT 1`, [actor.tenantId, id]);
  if (!result.rows[0]) throw new V12NotFoundError("Conversation introuvable.");
  const conversation = decodeConversation(result.rows[0]);
  if (!canUseResource(actor, scope, conversation)) throw new V12NotFoundError("Conversation introuvable.");
  return conversation;
}

export async function listInboxMessages(actor: AuthContext, conversationId: string, input: { limit?: number; offset?: number } = {}) {
  const conversation = await getInboxConversation(actor, conversationId);
  const limit = boundedInteger(input.limit ?? 100, 1, 200, "Limite invalide.");
  const offset = boundedInteger(input.offset ?? 0, 0, 10000, "Offset invalide.");
  const result = await getPool().query(
    `SELECT id,conversation_id,sender_kind,sender_user_id,direction,body,metadata,read_at,created_at
     FROM crm_inbox_messages WHERE tenant_id=$1 AND conversation_id=$2
     ORDER BY created_at ASC LIMIT $3 OFFSET $4`,
    [actor.tenantId, conversation.id, limit, offset],
  );
  return result.rows.map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    senderKind: row.sender_kind,
    senderUserId: row.sender_user_id,
    direction: row.direction,
    body: row.body,
    metadata: asObject(row.metadata) ?? {},
    readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

export async function createInboxConversation(actor: AuthContext, input: {
  subject: string;
  relatedRecordId?: string | null;
  assigneeId?: string | null;
  status?: string;
  firstMessage?: string | null;
}) {
  const scope = await requirePermission(actor, "timeline", "create");
  const subject = normalizeText(input.subject, 240, "Objet de conversation requis.");
  let relatedRecord = null;
  if (input.relatedRecordId) relatedRecord = await getCrmRecord(actor, normalizeId(input.relatedRecordId, "Fiche liée invalide."), "read");
  const teamId = relatedRecord?.teamId ?? actor.teamId;
  const ownerId = relatedRecord?.ownerId ?? actor.userId;
  const resource = { tenantId: actor.tenantId, teamId, ownerId };
  if (!canUseResource(actor, scope, resource)) throw new V12NotFoundError("Ressource introuvable.");
  const assigneeId = input.assigneeId ? await validateAssignee(actor, scope, input.assigneeId, teamId) : null;
  const status = normalizeStatus(input.status ?? "open");
  const conversationId = crypto.randomUUID();
  const messageBody = input.firstMessage ? normalizeText(input.firstMessage, 65536, "Message invalide.") : null;
  const now = new Date().toISOString();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO crm_inbox_conversations
       (id,tenant_id,team_id,owner_id,assignee_id,related_record_id,subject,status,unread_count,last_message_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$9,$9)`,
      [conversationId, actor.tenantId, teamId, ownerId, assigneeId, relatedRecord?.id ?? null, subject, status, now],
    );
    if (messageBody) {
      await client.query(
        `INSERT INTO crm_inbox_messages(id,tenant_id,conversation_id,sender_kind,sender_user_id,direction,body,metadata,read_at,created_at)
         VALUES ($1,$2,$3,'internal',$4,'internal',$5,'{}'::jsonb,$6,$6)`,
        [crypto.randomUUID(), actor.tenantId, conversationId, actor.userId, messageBody, now],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK"); throw error;
  } finally { client.release(); }
  if (relatedRecord) await appendTimeline(actor, relatedRecord, "inbox.conversation_created", `Conversation « ${subject} » créée`, { conversationId });
  await audit(actor, { action: "inbox.conversation_created", resourceType: "inbox_conversation", resourceId: conversationId, result: "success", details: { relatedRecordId: relatedRecord?.id ?? null } });
  return getInboxConversation(actor, conversationId);
}

export async function addInboxMessage(actor: AuthContext, conversationId: string, input: {
  body: string;
  direction?: string;
  senderKind?: string;
  metadata?: Record<string, unknown>;
}) {
  const scope = await requirePermission(actor, "timeline", "create");
  const conversation = await getInboxConversation(actor, conversationId);
  if (!canUseResource(actor, scope, conversation)) throw new V12NotFoundError("Conversation introuvable.");
  const body = normalizeText(input.body, 65536, "Message requis.");
  const direction = String(input.direction ?? "internal");
  if (!DIRECTIONS.has(direction)) throw new V12ValidationError("Direction de message invalide.");
  const senderKind = String(input.senderKind ?? (direction === "inbound" ? "external" : "internal"));
  if (!SENDER_KINDS.has(senderKind)) throw new V12ValidationError("Type d'émetteur invalide.");
  if (senderKind !== "internal" && direction !== "inbound") throw new V12ValidationError("Émetteur externe réservé aux messages entrants.");
  const metadata = input.metadata ?? {};
  if (JSON.stringify(metadata).length > 16384) throw new V12ValidationError("Métadonnées de message trop volumineuses.");
  const messageId = crypto.randomUUID();
  const now = new Date().toISOString();
  const unreadDelta = direction === "inbound" ? 1 : 0;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO crm_inbox_messages(id,tenant_id,conversation_id,sender_kind,sender_user_id,direction,body,metadata,read_at,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
      [messageId, actor.tenantId, conversation.id, senderKind, senderKind === "internal" ? actor.userId : null, direction, body, JSON.stringify(metadata), unreadDelta ? null : now, now],
    );
    await client.query(
      `UPDATE crm_inbox_conversations SET unread_count=unread_count+$1,last_message_at=$2,updated_at=$2 WHERE tenant_id=$3 AND id=$4`,
      [unreadDelta, now, actor.tenantId, conversation.id],
    );
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  if (conversation.relatedRecordId) {
    const record = await getCrmRecord(actor, conversation.relatedRecordId, "read");
    await appendTimeline(actor, record, "inbox.message_added", "Message ajouté à la conversation CRM", { conversationId: conversation.id, messageId, direction });
  }
  await audit(actor, { action: "inbox.message_added", resourceType: "inbox_message", resourceId: messageId, result: "success", details: { conversationId: conversation.id, direction } });
  return { id: messageId, conversationId: conversation.id, direction, senderKind, body, metadata, readAt: unreadDelta ? null : now, createdAt: now };
}

export async function updateInboxConversation(actor: AuthContext, conversationId: string, patch: {
  status?: string;
  assigneeId?: string | null;
  markRead?: boolean;
  relatedRecordId?: string | null;
}) {
  const scope = await requirePermission(actor, "timeline", "create");
  const conversation = await getInboxConversation(actor, conversationId);
  if (!canUseResource(actor, scope, conversation)) throw new V12NotFoundError("Conversation introuvable.");
  let status = conversation.status;
  if (patch.status !== undefined) status = normalizeStatus(patch.status);
  let relatedRecordId = conversation.relatedRecordId;
  let teamId = conversation.teamId;
  let ownerId = conversation.ownerId;
  if (patch.relatedRecordId !== undefined) {
    if (patch.relatedRecordId === null || patch.relatedRecordId === "") {
      relatedRecordId = null;
    } else {
      const record = await getCrmRecord(actor, normalizeId(patch.relatedRecordId, "Fiche liée invalide."), "read");
      relatedRecordId = record.id; teamId = record.teamId; ownerId = record.ownerId;
    }
  }
  if (!canUseResource(actor, scope, { tenantId: actor.tenantId, teamId, ownerId })) throw new V12NotFoundError("Fiche liée introuvable.");
  let assigneeId = conversation.assigneeId;
  if (patch.assigneeId !== undefined) assigneeId = patch.assigneeId ? await validateAssignee(actor, scope, patch.assigneeId, teamId) : null;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE crm_inbox_conversations SET status=$1,assignee_id=$2,related_record_id=$3,team_id=$4,owner_id=$5,
       unread_count=CASE WHEN $6::boolean THEN 0 ELSE unread_count END,updated_at=CURRENT_TIMESTAMP
       WHERE tenant_id=$7 AND id=$8`,
      [status, assigneeId, relatedRecordId, teamId, ownerId, patch.markRead === true, actor.tenantId, conversation.id],
    );
    if (patch.markRead === true) {
      await client.query(`UPDATE crm_inbox_messages SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP) WHERE tenant_id=$1 AND conversation_id=$2`, [actor.tenantId, conversation.id]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  await audit(actor, { action: "inbox.conversation_updated", resourceType: "inbox_conversation", resourceId: conversation.id, result: "success", before: conversation, details: { status, assigneeId, relatedRecordId, markRead: patch.markRead === true } });
  return getInboxConversation(actor, conversation.id);
}

async function validateAssignee(actor: AuthContext, scope: PermissionScope, assigneeId: string, conversationTeamId: string) {
  const id = normalizeId(assigneeId, "Responsable invalide.");
  const result = await getPool().query(`SELECT user_id,team_id FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active' LIMIT 1`, [actor.tenantId, id]);
  const row = result.rows[0];
  if (!row) throw new V12NotFoundError("Responsable introuvable.");
  if (scope !== "tenant" && row.team_id !== actor.teamId) throw new V12NotFoundError("Responsable introuvable.");
  if (scope !== "tenant" && conversationTeamId !== actor.teamId) throw new V12NotFoundError("Conversation introuvable.");
  return id;
}

function applyScopeFilter(actor: AuthContext, scope: PermissionScope, params: unknown[], clauses: string[], alias: string) {
  if (scope === "team") { params.push(actor.teamId); clauses.push(`${alias}.team_id=$${params.length}`); }
  if (scope === "personal") { params.push(actor.userId); clauses.push(`${alias}.owner_id=$${params.length}`); }
}

function decodeConversation(row: Record<string, unknown>): ConversationResource {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), teamId: String(row.team_id), ownerId: String(row.owner_id),
    assigneeId: row.assignee_id ? String(row.assignee_id) : null,
    relatedRecordId: row.related_record_id ? String(row.related_record_id) : null,
    subject: String(row.subject), status: String(row.status), unreadCount: Number(row.unread_count ?? 0),
    lastMessageAt: row.last_message_at ? new Date(row.last_message_at as string | Date).toISOString() : null,
    createdAt: new Date(row.created_at as string | Date).toISOString(), updatedAt: new Date(row.updated_at as string | Date).toISOString(),
  };
}
function normalizeStatus(value: string) { if (!STATUSES.has(value)) throw new V12ValidationError("Statut de conversation invalide."); return value; }
function normalizeId(value: string, message: string) { if (!ID_RE.test(value)) throw new V12ValidationError(message); return value; }
function normalizeText(value: string, max: number, message: string) { const text = typeof value === "string" ? value.trim() : ""; if (!text || Buffer.byteLength(text, "utf8") > max) throw new V12ValidationError(message); return text; }
function boundedInteger(value: unknown, min: number, max: number, message: string) { const number = Number(value); if (!Number.isInteger(number) || number < min || number > max) throw new V12ValidationError(message); return number; }
function asObject(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }

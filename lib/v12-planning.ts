import { createHash } from "node:crypto";

import { getPool } from "@/db";
import {
  audit,
  canUseResource,
  requirePermission,
  requireRecordPermission,
  type AuthContext,
} from "@/lib/authz";
import { createCrmRecord, getCrmRecord, type CrmRecord } from "@/lib/crm-core";
import { validateConfiguredRecordData } from "@/lib/crm-runtime-validation";
import { enqueueAutomationJob } from "@/lib/automation-queue";
import { extractKnownRecordRefs, validateRecordInput } from "@/lib/crm-policy.js";

const PUBLIC_ID_RE = /^[a-f0-9]{32}$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const RESOURCE_ID_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MAX_PUBLIC_BODY_BYTES = 64 * 1024;

export class V12ValidationError extends Error {
  status = 400;
}

export class V12ConflictError extends Error {
  status = 409;
}

export class V12NotFoundError extends Error {
  status = 404;
}

export class V12RateLimitError extends Error {
  status = 429;
}

type ResourceKind = "user" | "team";

type AvailabilityDefinition = {
  key: string;
  resourceKind: ResourceKind;
  resourceId: string;
  timezone: string;
  weekly: Array<{ weekday: number; start: string; end: string }>;
  exceptions: Array<{ date: string; available: boolean; start?: string; end?: string }>;
  durationMinutes: number;
  slotMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
};

type PublicationRow = {
  id: string;
  public_id: string;
  tenant_id: string;
  team_id: string;
  configuration_id: string;
  publication_kind: "form" | "appointment_booking";
  object_type: string;
  status: string;
  exposed_fields: unknown;
  policy: unknown;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type RuntimeRecord = CrmRecord & { data: Record<string, unknown> };

export async function readJsonBodyLimited(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_PUBLIC_BODY_BYTES) {
    throw new V12ValidationError("Requête trop volumineuse.");
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_PUBLIC_BODY_BYTES) {
    throw new V12ValidationError("Requête trop volumineuse.");
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new V12ValidationError("Payload JSON invalide.");
  }
}

export async function listPlanningReservations(actor: AuthContext, input: {
  from?: string | null;
  to?: string | null;
  resourceKind?: string | null;
  resourceId?: string | null;
}) {
  const planningScope = await requirePermission(actor, "planning", "read");
  const from = optionalDateTime(input.from, new Date(Date.now() - 24 * 60 * 60 * 1000));
  const to = optionalDateTime(input.to, new Date(Date.now() + 31 * 24 * 60 * 60 * 1000));
  if (to.getTime() <= from.getTime() || to.getTime() - from.getTime() > 93 * 24 * 60 * 60 * 1000) {
    throw new V12ValidationError("Fenêtre de planning invalide.");
  }
  const resourceKind = normalizeResourceKind(input.resourceKind ?? undefined);
  const resourceId = input.resourceId ? normalizeResourceId(input.resourceId) : null;
  if (resourceKind && resourceId) await assertResourceVisible(actor, planningScope, resourceKind, resourceId);

  const params: unknown[] = [actor.tenantId, from.toISOString(), to.toISOString()];
  const clauses = ["r.tenant_id = $1", "r.status = 'booked'", "r.ends_at > $2", "r.starts_at < $3"];
  if (resourceKind) {
    params.push(resourceKind);
    clauses.push(`r.resource_kind = $${params.length}`);
  }
  if (resourceId) {
    params.push(resourceId);
    clauses.push(`r.resource_id = $${params.length}`);
  }
  if (planningScope === "team") {
    params.push(actor.teamId);
    clauses.push(`c.team_id = $${params.length}`);
  } else if (planningScope === "personal") {
    params.push(actor.userId);
    clauses.push(`c.owner_id = $${params.length}`);
  }

  const result = await getPool().query({
    text: `
      SELECT r.id, r.appointment_id, r.resource_kind, r.resource_id,
             r.starts_at, r.ends_at, r.timezone,
             c.title, c.status AS appointment_status, c.team_id, c.owner_id, c.data
      FROM planning_reservations r
      JOIN crm_records c ON c.tenant_id = r.tenant_id AND c.id = r.appointment_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY r.starts_at ASC
      LIMIT 500
    `,
    values: params,
  });
  return result.rows.map((row) => ({
    id: row.id,
    appointmentId: row.appointment_id,
    resourceKind: row.resource_kind,
    resourceId: row.resource_id,
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    timezone: row.timezone,
    title: row.title,
    status: row.appointment_status,
    teamId: row.team_id,
    ownerId: row.owner_id,
  }));
}

export async function getAvailabilitySlots(actor: AuthContext, input: {
  resourceKind?: string | null;
  resourceId?: string | null;
  from: string;
  to: string;
  durationMinutes?: number;
}) {
  const scope = await requirePermission(actor, "planning", "read");
  const resourceKind = normalizeResourceKind(input.resourceKind ?? "user");
  const resourceId = normalizeResourceId(input.resourceId ?? (resourceKind === "user" ? actor.userId : actor.teamId));
  await assertResourceVisible(actor, scope, resourceKind, resourceId);
  return computeAvailabilitySlots({
    tenantId: actor.tenantId,
    resourceKind,
    resourceId,
    from: input.from,
    to: input.to,
    durationMinutes: input.durationMinutes,
  });
}

export async function computeAvailabilitySlots(input: {
  tenantId: string;
  resourceKind: ResourceKind;
  resourceId: string;
  from: string;
  to: string;
  durationMinutes?: number;
}) {
  const from = requiredDateTime(input.from, "Début de recherche invalide.");
  const to = requiredDateTime(input.to, "Fin de recherche invalide.");
  if (to.getTime() <= from.getTime() || to.getTime() - from.getTime() > 31 * 24 * 60 * 60 * 1000) {
    throw new V12ValidationError("Fenêtre de disponibilité invalide.");
  }
  const definition = await loadAvailabilityDefinition(input.tenantId, input.resourceKind, input.resourceId);
  if (!definition) return { configured: false, timezone: "UTC", slots: [] as Array<Record<string, unknown>> };
  const durationMinutes = boundedInteger(input.durationMinutes ?? definition.durationMinutes, 5, 480, "Durée invalide.");
  const reservations = await getPool().query({
    text: `SELECT blocked_starts_at, blocked_ends_at
           FROM planning_reservations
           WHERE tenant_id = $1 AND resource_kind = $2 AND resource_id = $3
             AND status = 'booked' AND blocked_ends_at > $4 AND blocked_starts_at < $5
           ORDER BY blocked_starts_at ASC`,
    values: [input.tenantId, input.resourceKind, input.resourceId, from.toISOString(), to.toISOString()],
  });
  const busy = reservations.rows.map((row) => ({
    start: new Date(row.blocked_starts_at).getTime(),
    end: new Date(row.blocked_ends_at).getTime(),
  }));

  const slots: Array<{ startsAt: string; endsAt: string; timezone: string }> = [];
  const cursor = new Date(from);
  cursor.setUTCHours(0, 0, 0, 0);
  const lastDay = new Date(to);
  lastDay.setUTCHours(23, 59, 59, 999);
  while (cursor.getTime() <= lastDay.getTime() && slots.length < 1000) {
    const localDate = formatDateInZone(cursor, definition.timezone);
    const windows = windowsForDate(definition, localDate);
    for (const window of windows) {
      const windowStart = zonedDateTimeToUtc(localDate, window.start, definition.timezone);
      const windowEnd = zonedDateTimeToUtc(localDate, window.end, definition.timezone);
      for (
        let startMs = windowStart.getTime();
        startMs + durationMinutes * 60_000 <= windowEnd.getTime() && slots.length < 1000;
        startMs += definition.slotMinutes * 60_000
      ) {
        const endMs = startMs + durationMinutes * 60_000;
        if (startMs < from.getTime() || endMs > to.getTime()) continue;
        const blockedStart = startMs - definition.bufferBeforeMinutes * 60_000;
        const blockedEnd = endMs + definition.bufferAfterMinutes * 60_000;
        if (busy.some((interval) => blockedStart < interval.end && blockedEnd > interval.start)) continue;
        slots.push({
          startsAt: new Date(startMs).toISOString(),
          endsAt: new Date(endMs).toISOString(),
          timezone: definition.timezone,
        });
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return { configured: true, timezone: definition.timezone, durationMinutes, slots };
}

export async function bookAppointment(actor: AuthContext, input: {
  title: string;
  startsAt: string;
  endsAt: string;
  timezone?: string;
  resourceKind?: string;
  resourceId?: string;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  idempotencyKey: string;
  data?: Record<string, unknown>;
}) {
  const planningScope = await requirePermission(actor, "planning", "read");
  await requireRecordPermission(actor, "appointment", "create");
  const resourceKind = normalizeResourceKind(input.resourceKind ?? "user");
  const resourceId = normalizeResourceId(input.resourceId ?? (resourceKind === "user" ? actor.userId : actor.teamId));
  await assertResourceVisible(actor, planningScope, resourceKind, resourceId);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const startsAt = requiredDateTime(input.startsAt, "Début de rendez-vous invalide.");
  const endsAt = requiredDateTime(input.endsAt, "Fin de rendez-vous invalide.");
  if (endsAt <= startsAt) throw new V12ValidationError("Intervalle de rendez-vous invalide.");
  if (endsAt.getTime() - startsAt.getTime() > 8 * 60 * 60 * 1000) throw new V12ValidationError("Rendez-vous trop long.");

  const definition = await loadAvailabilityDefinition(actor.tenantId, resourceKind, resourceId);
  if (!definition) throw new V12ConflictError("Aucune disponibilité publiée pour cette ressource.");
  const candidateSlots = await computeAvailabilitySlots({
    tenantId: actor.tenantId,
    resourceKind,
    resourceId,
    from: startsAt.toISOString(),
    to: endsAt.toISOString(),
    durationMinutes: Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000),
  });
  if (!candidateSlots.slots.some((slot) => slot.startsAt === startsAt.toISOString() && slot.endsAt === endsAt.toISOString())) {
    throw new V12ConflictError("Le créneau n'est plus disponible.");
  }

  const payload = validateRecordInput({
    type: "appointment",
    title: input.title,
    status: "active",
    data: {
      ...(input.data ?? {}),
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      timezone: normalizeTimezone(input.timezone ?? definition.timezone),
      resourceKind,
      resourceId,
    },
  });
  if (!payload.ok) throw new V12ValidationError(payload.error);
  await validateConfiguredRecordData(actor.tenantId, "appointment", payload.value.data);
  await assertReferencesBelongToTenant(actor.tenantId, payload.value.data);

  const existing = await findIdempotentAppointment(actor.tenantId, idempotencyKey);
  if (existing) return existing;

  const appointmentId = crypto.randomUUID();
  const reservationId = crypto.randomUUID();
  const now = new Date().toISOString();
  const beforeMinutes = boundedInteger(input.bufferBeforeMinutes ?? definition.bufferBeforeMinutes, 0, 240, "Tampon avant invalide.");
  const afterMinutes = boundedInteger(input.bufferAfterMinutes ?? definition.bufferAfterMinutes, 0, 240, "Tampon après invalide.");
  const blockedStartsAt = new Date(startsAt.getTime() - beforeMinutes * 60_000);
  const blockedEndsAt = new Date(endsAt.getTime() + afterMinutes * 60_000);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO crm_records
        (id, tenant_id, team_id, owner_id, type, title, data, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'appointment',$5,$6,'active',$7,$7)`,
      [appointmentId, actor.tenantId, actor.teamId, actor.userId, payload.value.title, JSON.stringify(payload.value.data), now],
    );
    await client.query(
      `INSERT INTO planning_reservations
        (id, tenant_id, appointment_id, resource_kind, resource_id, starts_at, ends_at,
         blocked_starts_at, blocked_ends_at, timezone, status, idempotency_key, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'booked',$11,$12,$13,$13)`,
      [reservationId, actor.tenantId, appointmentId, resourceKind, resourceId,
        startsAt.toISOString(), endsAt.toISOString(), blockedStartsAt.toISOString(), blockedEndsAt.toISOString(),
        payload.value.data.timezone, idempotencyKey, actor.userId, now],
    );
    await client.query(
      `INSERT INTO crm_timeline_events
        (tenant_id, team_id, owner_id, record_id, event_type, summary, data, actor_id, created_at)
       VALUES ($1,$2,$3,$4,'planning.booked',$5,$6,$7,$8)`,
      [actor.tenantId, actor.teamId, actor.userId, appointmentId, `${payload.value.title} réservé`,
        JSON.stringify({ resourceKind, resourceId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }), actor.userId, now],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    if (isPgConflict(error)) {
      const replay = await findIdempotentAppointment(actor.tenantId, idempotencyKey);
      if (replay) return replay;
      throw new V12ConflictError("Le créneau vient d'être réservé par une autre opération.");
    }
    throw error;
  } finally {
    client.release();
  }

  const record: RuntimeRecord = {
    id: appointmentId,
    tenantId: actor.tenantId,
    teamId: actor.teamId,
    ownerId: actor.userId,
    type: "appointment",
    title: payload.value.title,
    data: payload.value.data,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  await audit(actor, {
    action: "planning.booked",
    resourceType: "appointment",
    resourceId: appointmentId,
    result: "success",
    after: record,
    details: { resourceKind, resourceId, reservationId },
  });
  await enqueueAutomationJob(actor, "record.created", record);
  return record;
}

export async function rescheduleAppointment(actor: AuthContext, input: {
  appointmentId: string;
  startsAt: string;
  endsAt: string;
  timezone?: string;
}) {
  const record = await getCrmRecord(actor, input.appointmentId, "update");
  if (record.type !== "appointment") throw new V12ValidationError("La ressource n'est pas un rendez-vous.");
  const reservation = await getPool().query(
    `SELECT * FROM planning_reservations WHERE tenant_id = $1 AND appointment_id = $2 AND status = 'booked' LIMIT 1`,
    [actor.tenantId, record.id],
  );
  const current = reservation.rows[0];
  if (!current) throw new V12NotFoundError("Réservation de planning introuvable.");
  const scope = await requirePermission(actor, "planning", "read");
  await assertResourceVisible(actor, scope, current.resource_kind, current.resource_id);
  const startsAt = requiredDateTime(input.startsAt, "Début invalide.");
  const endsAt = requiredDateTime(input.endsAt, "Fin invalide.");
  if (endsAt <= startsAt) throw new V12ValidationError("Intervalle invalide.");
  const definition = await loadAvailabilityDefinition(actor.tenantId, current.resource_kind, current.resource_id);
  if (!definition) throw new V12ConflictError("Aucune disponibilité configurée.");
  const durationMinutes = Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000);
  const slots = await computeAvailabilitySlotsIgnoringReservation({
    tenantId: actor.tenantId,
    resourceKind: current.resource_kind,
    resourceId: current.resource_id,
    from: startsAt.toISOString(),
    to: endsAt.toISOString(),
    durationMinutes,
    ignoredReservationId: current.id,
  });
  if (!slots.some((slot) => slot.startsAt === startsAt.toISOString() && slot.endsAt === endsAt.toISOString())) {
    throw new V12ConflictError("Le nouveau créneau n'est pas disponible.");
  }
  const data = { ...record.data, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), timezone: normalizeTimezone(input.timezone ?? current.timezone) };
  const validation = validateRecordInput({ type: "appointment", title: record.title, status: record.status, data });
  if (!validation.ok) throw new V12ValidationError(validation.error);
  const blockedStartsAt = new Date(startsAt.getTime() - definition.bufferBeforeMinutes * 60_000);
  const blockedEndsAt = new Date(endsAt.getTime() + definition.bufferAfterMinutes * 60_000);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE planning_reservations SET starts_at=$1, ends_at=$2, blocked_starts_at=$3, blocked_ends_at=$4,
       timezone=$5, updated_at=CURRENT_TIMESTAMP WHERE tenant_id=$6 AND id=$7 AND status='booked'`,
      [startsAt.toISOString(), endsAt.toISOString(), blockedStartsAt.toISOString(), blockedEndsAt.toISOString(),
        validation.value.data.timezone, actor.tenantId, current.id],
    );
    await client.query(
      `UPDATE crm_records SET data=$1, updated_at=CURRENT_TIMESTAMP WHERE tenant_id=$2 AND id=$3`,
      [JSON.stringify(validation.value.data), actor.tenantId, record.id],
    );
    await client.query(
      `INSERT INTO crm_timeline_events
        (tenant_id, team_id, owner_id, record_id, event_type, summary, data, actor_id)
       VALUES ($1,$2,$3,$4,'planning.rescheduled',$5,$6,$7)`,
      [actor.tenantId, record.teamId, record.ownerId, record.id, `${record.title} déplacé`,
        JSON.stringify({ startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }), actor.userId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    if (isPgConflict(error)) throw new V12ConflictError("Le nouveau créneau entre en conflit avec une autre réservation.");
    throw error;
  } finally {
    client.release();
  }
  await audit(actor, { action: "planning.rescheduled", resourceType: "appointment", resourceId: record.id, result: "success", details: { startsAt, endsAt } });
  return getCrmRecord(actor, record.id);
}

export async function cancelAppointment(actor: AuthContext, appointmentId: string) {
  const record = await getCrmRecord(actor, appointmentId, "update");
  if (record.type !== "appointment") throw new V12ValidationError("La ressource n'est pas un rendez-vous.");
  const data = { ...record.data, cancelledAt: new Date().toISOString() };
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE planning_reservations SET status='cancelled', updated_at=CURRENT_TIMESTAMP
       WHERE tenant_id=$1 AND appointment_id=$2 AND status='booked' RETURNING id`,
      [actor.tenantId, record.id],
    );
    if (!updated.rowCount) throw new V12NotFoundError("Réservation active introuvable.");
    await client.query(`UPDATE crm_records SET status='cancelled', data=$1, updated_at=CURRENT_TIMESTAMP WHERE tenant_id=$2 AND id=$3`, [JSON.stringify(data), actor.tenantId, record.id]);
    await client.query(
      `INSERT INTO crm_timeline_events
       (tenant_id, team_id, owner_id, record_id, event_type, summary, data, actor_id)
       VALUES ($1,$2,$3,$4,'planning.cancelled',$5,'{}',$6)`,
      [actor.tenantId, record.teamId, record.ownerId, record.id, `${record.title} annulé`, actor.userId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await audit(actor, { action: "planning.cancelled", resourceType: "appointment", resourceId: record.id, result: "success" });
  return { ...record, status: "cancelled", data };
}

export async function createPublicPublication(actor: AuthContext, input: {
  formKey: string;
  kind?: string;
  exposedFields?: string[];
  expiresAt?: string | null;
  policy?: Record<string, unknown>;
}) {
  await requirePermission(actor, "crm_configuration", "administer");
  const formKey = normalizeKey(input.formKey, "Clé de formulaire invalide.");
  const result = await getPool().query(
    `SELECT id, definition FROM crm_configurations
     WHERE tenant_id=$1 AND kind='form' AND active=1 AND lower(btrim(definition::jsonb ->> 'key'))=$2 LIMIT 1`,
    [actor.tenantId, formKey],
  );
  if (!result.rows[0]) throw new V12NotFoundError("Formulaire actif introuvable.");
  const definition = asObject(parseJson(result.rows[0].definition));
  const objectType = typeof definition?.objectType === "string" ? definition.objectType : "";
  if (!objectType) throw new V12ValidationError("Objet cible du formulaire invalide.");
  const availableFields = new Set(
    (Array.isArray(definition?.fields) ? definition.fields : [])
      .map((field) => asObject(field)?.key)
      .filter((key): key is string => typeof key === "string"),
  );
  const requested = input.exposedFields ?? [...availableFields];
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > 50 || requested.some((field) => !availableFields.has(field))) {
    throw new V12ValidationError("Champs publics invalides.");
  }
  const kind = input.kind === "appointment_booking" ? "appointment_booking" : "form";
  if (kind === "appointment_booking" && objectType !== "appointment") {
    throw new V12ValidationError("Une réservation publique doit cibler l'objet appointment.");
  }
  const expiresAt = input.expiresAt ? requiredDateTime(input.expiresAt, "Expiration invalide.") : null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) throw new V12ValidationError("Expiration déjà atteinte.");
  if (expiresAt && expiresAt.getTime() > Date.now() + 366 * 24 * 60 * 60 * 1000) throw new V12ValidationError("Expiration trop éloignée.");
  const policy = normalizePublicationPolicy(kind, input.policy ?? {}, actor);
  const id = crypto.randomUUID();
  const publicId = crypto.randomUUID().replaceAll("-", "");
  await getPool().query(
    `INSERT INTO crm_publications
      (id,public_id,tenant_id,team_id,configuration_id,publication_kind,object_type,status,exposed_fields,policy,expires_at,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8::jsonb,$9::jsonb,$10,$11)`,
    [id, publicId, actor.tenantId, actor.teamId, result.rows[0].id, kind, objectType,
      JSON.stringify(requested), JSON.stringify(policy), expiresAt?.toISOString() ?? null, actor.userId],
  );
  await audit(actor, { action: "public_publication.created", resourceType: "public_publication", resourceId: id, result: "success", details: { formKey, kind, objectType } });
  return { id, publicId, kind, objectType, exposedFields: requested, expiresAt: expiresAt?.toISOString() ?? null, status: "active", policy: safePublicPolicy(policy) };
}

export async function listPublicPublications(actor: AuthContext) {
  await requirePermission(actor, "crm_configuration", "read");
  const result = await getPool().query(
    `SELECT p.id,p.public_id,p.publication_kind,p.object_type,p.status,p.exposed_fields,p.policy,p.expires_at,p.revoked_at,p.created_at,
            c.name AS form_name, c.definition AS form_definition
     FROM crm_publications p JOIN crm_configurations c ON c.tenant_id=p.tenant_id AND c.id=p.configuration_id
     WHERE p.tenant_id=$1 ORDER BY p.created_at DESC LIMIT 200`,
    [actor.tenantId],
  );
  return result.rows.map((row) => ({
    id: row.id, publicId: row.public_id, kind: row.publication_kind, objectType: row.object_type,
    status: row.status, exposedFields: row.exposed_fields, expiresAt: row.expires_at ? iso(row.expires_at) : null,
    revokedAt: row.revoked_at ? iso(row.revoked_at) : null, formName: row.form_name,
    formKey: asObject(parseJson(row.form_definition))?.key ?? "", policy: safePublicPolicy(asObject(row.policy) ?? {}),
  }));
}

export async function revokePublicPublication(actor: AuthContext, id: string) {
  await requirePermission(actor, "crm_configuration", "administer");
  const result = await getPool().query(
    `UPDATE crm_publications SET status='revoked', revoked_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
     WHERE tenant_id=$1 AND id=$2 AND status='active' RETURNING id`,
    [actor.tenantId, id],
  );
  if (!result.rowCount) throw new V12NotFoundError("Publication active introuvable.");
  await audit(actor, { action: "public_publication.revoked", resourceType: "public_publication", resourceId: id, result: "success" });
  return { id, status: "revoked" };
}

export async function getPublicMetadata(publicId: string) {
  const publication = await loadPublication(publicId);
  const definitionResult = await getPool().query(`SELECT name,definition FROM crm_configurations WHERE tenant_id=$1 AND id=$2 AND active=1 LIMIT 1`, [publication.tenant_id, publication.configuration_id]);
  if (!definitionResult.rows[0]) throw new V12NotFoundError("Publication indisponible.");
  const definition = asObject(parseJson(definitionResult.rows[0].definition)) ?? {};
  const exposed = new Set<string>(asStringArray(publication.exposed_fields));
  const fields = (Array.isArray(definition.fields) ? definition.fields : [])
    .map(asObject)
    .filter((field): field is Record<string, unknown> => Boolean(field && typeof field.key === "string" && exposed.has(field.key)))
    .map((field) => ({ key: field.key, label: field.label ?? field.key, type: field.type ?? "text", required: field.required === true }));
  const policy = asObject(publication.policy) ?? {};
  return {
    publicId: publication.public_id,
    kind: publication.publication_kind,
    name: definitionResult.rows[0].name,
    fields,
    expiresAt: publication.expires_at ? iso(publication.expires_at) : null,
    serviceLabel: typeof policy.serviceLabel === "string" ? policy.serviceLabel : null,
    resourceSelection: policy.resourceSelection === "public" ? "public" : "fixed",
  };
}

export async function getPublicBookingSlots(publicId: string, input: { from: string; to: string; durationMinutes?: number }) {
  const publication = await loadPublication(publicId, "appointment_booking");
  const policy = asObject(publication.policy) ?? {};
  const resourceKind = normalizeResourceKind(policy.resourceKind ?? "team");
  const resourceId = normalizeResourceId(String(policy.resourceId ?? publication.team_id));
  const result = await computeAvailabilitySlots({ tenantId: publication.tenant_id, resourceKind, resourceId, from: input.from, to: input.to, durationMinutes: input.durationMinutes });
  return { configured: result.configured, timezone: result.timezone, durationMinutes: result.durationMinutes, slots: result.slots };
}

export async function submitPublicPublication(publicId: string, request: Request) {
  const publication = await loadPublication(publicId);
  const body = await readJsonBodyLimited(request);
  const idempotencyKey = normalizeIdempotencyKey(request.headers.get("idempotency-key") ?? String(body.idempotencyKey ?? ""));
  const policy = asObject(publication.policy) ?? {};
  const limit = boundedInteger(policy.rateLimitPerHour ?? 20, 1, 500, "Limite anti-abus invalide.");
  await consumePublicRateLimit(publication.id, requestFingerprint(request), limit);

  const replay = await getPool().query(
    `SELECT record_id,response_status FROM crm_public_submission_receipts
     WHERE tenant_id=$1 AND publication_id=$2 AND idempotency_key=$3 LIMIT 1`,
    [publication.tenant_id, publication.id, idempotencyKey],
  );
  if (replay.rows[0]?.record_id) {
    return { replayed: true, recordId: replay.rows[0].record_id, status: Number(replay.rows[0].response_status) || 200 };
  }

  const values = asObject(body.values) ?? {};
  const definitionResult = await getPool().query(`SELECT definition FROM crm_configurations WHERE tenant_id=$1 AND id=$2 AND active=1 LIMIT 1`, [publication.tenant_id, publication.configuration_id]);
  if (!definitionResult.rows[0]) throw new V12NotFoundError("Publication indisponible.");
  const definition = asObject(parseJson(definitionResult.rows[0].definition)) ?? {};
  const allowedFields = new Set(asStringArray(publication.exposed_fields));
  const formFields = new Map<string, Record<string, unknown>>();
  for (const raw of Array.isArray(definition.fields) ? definition.fields : []) {
    const field = asObject(raw);
    if (field && typeof field.key === "string" && allowedFields.has(field.key)) formFields.set(field.key, field);
  }
  const permitted: Record<string, unknown> = {};
  for (const [key, field] of formFields) {
    const value = values[key];
    const missing = value === undefined || value === null || value === "";
    if (field.required === true && missing) throw new V12ValidationError(`Champ obligatoire manquant : ${key}.`);
    if (!missing) permitted[key] = normalizePublicValue(value);
  }
  const title = typeof permitted.title === "string" ? permitted.title.trim().slice(0, 160) : "";
  if (!title) throw new V12ValidationError("Titre requis.");
  delete permitted.title;
  delete permitted.status;
  const actor = await publicationActor(publication);

  if (publication.publication_kind === "appointment_booking") {
    const startsAt = typeof body.startsAt === "string" ? body.startsAt : "";
    const endsAt = typeof body.endsAt === "string" ? body.endsAt : "";
    const resourceKind = normalizeResourceKind(policy.resourceKind ?? "team");
    const resourceId = normalizeResourceId(String(policy.resourceId ?? publication.team_id));
    const record = await bookAppointment(actor, {
      title,
      startsAt,
      endsAt,
      timezone: typeof body.timezone === "string" ? body.timezone : undefined,
      resourceKind,
      resourceId,
      idempotencyKey: `pub:${publication.id}:${idempotencyKey}`.slice(0, 128),
      data: { ...permitted, publicPublicationId: publication.id, source: "public_booking" },
    });
    await storePublicReceipt(publication, idempotencyKey, record.id, 201);
    return { replayed: false, recordId: record.id, status: 201 };
  }

  const claimed = await claimPublicReceipt(publication, idempotencyKey);
  if (!claimed) {
    const prior = await waitForPublicReceipt(publication, idempotencyKey);
    if (prior) return { replayed: true, recordId: prior.recordId, status: prior.status };
    throw new V12ConflictError("Soumission identique déjà en cours.");
  }
  try {
    const record = await createCrmRecord(actor, {
      type: publication.object_type,
      title,
      status: "active",
      data: { ...permitted, publicPublicationId: publication.id, source: "public_form" },
    });
    await getPool().query(
      `UPDATE crm_public_submission_receipts SET record_id=$1,response_status=201 WHERE tenant_id=$2 AND publication_id=$3 AND idempotency_key=$4`,
      [record.id, publication.tenant_id, publication.id, idempotencyKey],
    );
    return { replayed: false, recordId: record.id, status: 201 };
  } catch (error) {
    await getPool().query(`DELETE FROM crm_public_submission_receipts WHERE tenant_id=$1 AND publication_id=$2 AND idempotency_key=$3 AND record_id IS NULL`, [publication.tenant_id, publication.id, idempotencyKey]);
    throw error;
  }
}

export function v12ErrorResponse(error: unknown) {
  if (error instanceof V12ValidationError || error instanceof V12ConflictError || error instanceof V12NotFoundError || error instanceof V12RateLimitError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  return null;
}

async function loadAvailabilityDefinition(tenantId: string, resourceKind: ResourceKind, resourceId: string): Promise<AvailabilityDefinition | null> {
  const result = await getPool().query(
    `SELECT definition FROM crm_configurations WHERE tenant_id=$1 AND kind='availability' AND active=1 ORDER BY version DESC,updated_at DESC LIMIT 200`,
    [tenantId],
  );
  for (const row of result.rows) {
    const parsed = asObject(parseJson(row.definition));
    if (!parsed || parsed.resourceKind !== resourceKind || parsed.resourceId !== resourceId) continue;
    try { return normalizeAvailabilityDefinition(parsed); } catch { continue; }
  }
  return null;
}

export function normalizeAvailabilityDefinition(input: Record<string, unknown>): AvailabilityDefinition {
  const key = normalizeKey(input.key, "Clé de disponibilité invalide.");
  const resourceKind = normalizeResourceKind(input.resourceKind);
  const resourceId = normalizeResourceId(String(input.resourceId ?? ""));
  const timezone = normalizeTimezone(String(input.timezone ?? "UTC"));
  const weeklyRaw = Array.isArray(input.weekly) ? input.weekly : [];
  if (weeklyRaw.length > 21) throw new V12ValidationError("Trop de fenêtres hebdomadaires.");
  const weekly = weeklyRaw.map((raw) => {
    const item = asObject(raw);
    const weekday = boundedInteger(item?.weekday, 0, 6, "Jour hebdomadaire invalide.");
    const start = normalizeTime(String(item?.start ?? ""));
    const end = normalizeTime(String(item?.end ?? ""));
    if (end <= start) throw new V12ValidationError("Fenêtre horaire invalide.");
    return { weekday, start, end };
  });
  const exceptionsRaw = Array.isArray(input.exceptions) ? input.exceptions : [];
  if (exceptionsRaw.length > 366) throw new V12ValidationError("Trop d'exceptions de disponibilité.");
  const exceptions = exceptionsRaw.map((raw) => {
    const item = asObject(raw);
    const date = String(item?.date ?? "");
    if (!DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new V12ValidationError("Date d'exception invalide.");
    const available = item?.available === true;
    if (!available) return { date, available: false };
    const start = normalizeTime(String(item?.start ?? ""));
    const end = normalizeTime(String(item?.end ?? ""));
    if (end <= start) throw new V12ValidationError("Fenêtre d'exception invalide.");
    return { date, available: true, start, end };
  });
  return {
    key, resourceKind, resourceId, timezone, weekly, exceptions,
    durationMinutes: boundedInteger(input.durationMinutes ?? 30, 5, 480, "Durée par défaut invalide."),
    slotMinutes: boundedInteger(input.slotMinutes ?? 15, 5, 240, "Pas de créneau invalide."),
    bufferBeforeMinutes: boundedInteger(input.bufferBeforeMinutes ?? 0, 0, 240, "Tampon avant invalide."),
    bufferAfterMinutes: boundedInteger(input.bufferAfterMinutes ?? 0, 0, 240, "Tampon après invalide."),
  };
}

async function computeAvailabilitySlotsIgnoringReservation(input: {
  tenantId: string; resourceKind: ResourceKind; resourceId: string; from: string; to: string; durationMinutes: number; ignoredReservationId: string;
}) {
  const definition = await loadAvailabilityDefinition(input.tenantId, input.resourceKind, input.resourceId);
  if (!definition) return [];
  const from = requiredDateTime(input.from, "Début invalide.");
  const to = requiredDateTime(input.to, "Fin invalide.");
  const busyResult = await getPool().query(
    `SELECT blocked_starts_at,blocked_ends_at FROM planning_reservations
     WHERE tenant_id=$1 AND resource_kind=$2 AND resource_id=$3 AND status='booked' AND id<>$4
       AND blocked_ends_at>$5 AND blocked_starts_at<$6`,
    [input.tenantId, input.resourceKind, input.resourceId, input.ignoredReservationId, from.toISOString(), to.toISOString()],
  );
  const busy = busyResult.rows.map((row) => ({ start: new Date(row.blocked_starts_at).getTime(), end: new Date(row.blocked_ends_at).getTime() }));
  const localDate = formatDateInZone(from, definition.timezone);
  const slots: Array<{ startsAt: string; endsAt: string }> = [];
  for (const window of windowsForDate(definition, localDate)) {
    const windowStart = zonedDateTimeToUtc(localDate, window.start, definition.timezone).getTime();
    const windowEnd = zonedDateTimeToUtc(localDate, window.end, definition.timezone).getTime();
    for (let start = windowStart; start + input.durationMinutes * 60_000 <= windowEnd; start += definition.slotMinutes * 60_000) {
      const end = start + input.durationMinutes * 60_000;
      const blockedStart = start - definition.bufferBeforeMinutes * 60_000;
      const blockedEnd = end + definition.bufferAfterMinutes * 60_000;
      if (!busy.some((interval) => blockedStart < interval.end && blockedEnd > interval.start)) slots.push({ startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() });
    }
  }
  return slots;
}

async function assertResourceVisible(actor: AuthContext, scope: "personal" | "team" | "tenant", resourceKind: ResourceKind, resourceId: string) {
  if (resourceKind === "team") {
    if (scope === "personal" && resourceId !== actor.teamId) throw new V12NotFoundError("Ressource introuvable.");
    if (scope === "team" && resourceId !== actor.teamId) throw new V12NotFoundError("Ressource introuvable.");
    const team = await getPool().query(`SELECT id FROM teams WHERE tenant_id=$1 AND id=$2 LIMIT 1`, [actor.tenantId, resourceId]);
    if (!team.rows[0]) throw new V12NotFoundError("Ressource introuvable.");
    return;
  }
  if (scope === "personal" && resourceId !== actor.userId) throw new V12NotFoundError("Ressource introuvable.");
  const member = await getPool().query(`SELECT user_id,team_id FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active' LIMIT 1`, [actor.tenantId, resourceId]);
  if (!member.rows[0]) throw new V12NotFoundError("Ressource introuvable.");
  if (scope === "team" && member.rows[0].team_id !== actor.teamId) throw new V12NotFoundError("Ressource introuvable.");
}

async function assertReferencesBelongToTenant(tenantId: string, data: Record<string, unknown>) {
  const ids = extractKnownRecordRefs(data);
  if (!ids.length) return;
  const result = await getPool().query(`SELECT id FROM crm_records WHERE tenant_id=$1 AND id=ANY($2::text[])`, [tenantId, ids]);
  if (result.rows.length !== ids.length) throw new V12ValidationError("Référence CRM étrangère ou absente.");
}

async function findIdempotentAppointment(tenantId: string, idempotencyKey: string): Promise<RuntimeRecord | null> {
  const result = await getPool().query(
    `SELECT c.* FROM planning_reservations r JOIN crm_records c ON c.tenant_id=r.tenant_id AND c.id=r.appointment_id
     WHERE r.tenant_id=$1 AND r.idempotency_key=$2 LIMIT 1`,
    [tenantId, idempotencyKey],
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  return {
    id: row.id, tenantId: row.tenant_id, teamId: row.team_id, ownerId: row.owner_id,
    type: row.type, title: row.title, data: asObject(parseJson(row.data)) ?? {}, status: row.status,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

async function loadPublication(publicId: string, expectedKind?: "appointment_booking" | "form"): Promise<PublicationRow> {
  if (!PUBLIC_ID_RE.test(publicId)) throw new V12NotFoundError("Publication introuvable.");
  const result = await getPool().query(`SELECT * FROM crm_publications WHERE public_id=$1 LIMIT 1`, [publicId]);
  const row = result.rows[0] as PublicationRow | undefined;
  if (!row || row.status !== "active" || row.revoked_at || (row.expires_at && new Date(row.expires_at).getTime() <= Date.now())) {
    throw new V12NotFoundError("Publication introuvable ou expirée.");
  }
  if (expectedKind && row.publication_kind !== expectedKind) throw new V12NotFoundError("Publication introuvable.");
  return row;
}

async function publicationActor(publication: PublicationRow): Promise<AuthContext> {
  const result = await getPool().query(
    `SELECT u.email,u.display_name,m.role,m.status,m.team_id FROM users u
     JOIN memberships m ON m.user_id=u.id AND m.tenant_id=$1
     WHERE u.id=$2 AND m.status='active' LIMIT 1`,
    [publication.tenant_id, publication.created_by],
  );
  const row = result.rows[0];
  if (!row) throw new V12NotFoundError("Publication indisponible.");
  return {
    userId: publication.created_by,
    email: row.email,
    displayName: row.display_name,
    tenantId: publication.tenant_id,
    teamId: publication.team_id,
    role: row.role === "admin" ? "admin" : "user",
  };
}

async function consumePublicRateLimit(publicationId: string, bucketHash: string, limit: number) {
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / 3_600_000) * 3_600_000).toISOString();
  const result = await getPool().query(
    `INSERT INTO crm_public_rate_limits(publication_id,bucket_hash,window_start,request_count)
     VALUES ($1,$2,$3,1)
     ON CONFLICT(publication_id,bucket_hash,window_start)
     DO UPDATE SET request_count=crm_public_rate_limits.request_count+1,updated_at=CURRENT_TIMESTAMP
     RETURNING request_count`,
    [publicationId, bucketHash, windowStart],
  );
  if (Number(result.rows[0]?.request_count ?? 0) > limit) throw new V12RateLimitError("Trop de requêtes publiques.");
}

async function claimPublicReceipt(publication: PublicationRow, idempotencyKey: string) {
  const result = await getPool().query(
    `INSERT INTO crm_public_submission_receipts(id,tenant_id,publication_id,idempotency_key,response_status)
     VALUES ($1,$2,$3,$4,201) ON CONFLICT(tenant_id,publication_id,idempotency_key) DO NOTHING RETURNING id`,
    [crypto.randomUUID(), publication.tenant_id, publication.id, idempotencyKey],
  );
  return Boolean(result.rows[0]);
}

async function waitForPublicReceipt(publication: PublicationRow, idempotencyKey: string) {
  const result = await getPool().query(
    `SELECT record_id,response_status FROM crm_public_submission_receipts WHERE tenant_id=$1 AND publication_id=$2 AND idempotency_key=$3 LIMIT 1`,
    [publication.tenant_id, publication.id, idempotencyKey],
  );
  if (!result.rows[0]?.record_id) return null;
  return { recordId: result.rows[0].record_id as string, status: Number(result.rows[0].response_status) || 200 };
}

async function storePublicReceipt(publication: PublicationRow, idempotencyKey: string, recordId: string, status: number) {
  await getPool().query(
    `INSERT INTO crm_public_submission_receipts(id,tenant_id,publication_id,idempotency_key,record_id,response_status)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT(tenant_id,publication_id,idempotency_key)
     DO UPDATE SET record_id=EXCLUDED.record_id,response_status=EXCLUDED.response_status`,
    [crypto.randomUUID(), publication.tenant_id, publication.id, idempotencyKey, recordId, status],
  );
}

function normalizePublicationPolicy(kind: string, input: Record<string, unknown>, actor: AuthContext) {
  const policy: Record<string, unknown> = {
    rateLimitPerHour: boundedInteger(input.rateLimitPerHour ?? 20, 1, 500, "Limite anti-abus invalide."),
    idempotencyRequired: true,
  };
  if (kind === "appointment_booking") {
    const resourceKind = normalizeResourceKind(input.resourceKind ?? "team");
    const resourceId = normalizeResourceId(String(input.resourceId ?? (resourceKind === "team" ? actor.teamId : actor.userId)));
    policy.resourceKind = resourceKind;
    policy.resourceId = resourceId;
    policy.resourceSelection = input.resourceSelection === "public" ? "public" : "fixed";
    if (typeof input.serviceLabel === "string") policy.serviceLabel = input.serviceLabel.trim().slice(0, 120);
  }
  return policy;
}

function safePublicPolicy(policy: Record<string, unknown>) {
  return {
    rateLimitPerHour: Number(policy.rateLimitPerHour ?? 20),
    idempotencyRequired: true,
    resourceSelection: policy.resourceSelection === "public" ? "public" : "fixed",
    serviceLabel: typeof policy.serviceLabel === "string" ? policy.serviceLabel : undefined,
  };
}

function windowsForDate(definition: AvailabilityDefinition, date: string) {
  const exception = definition.exceptions.find((item) => item.date === date);
  if (exception) return exception.available && exception.start && exception.end ? [{ start: exception.start, end: exception.end }] : [];
  const localNoonUtc = zonedDateTimeToUtc(date, "12:00", definition.timezone);
  const weekday = Number(new Intl.DateTimeFormat("en-US", { timeZone: definition.timezone, weekday: "short" }).formatToParts(localNoonUtc).find((part) => part.type === "weekday")?.value === undefined
    ? localNoonUtc.getUTCDay()
    : localNoonUtc.getUTCDay());
  const actualWeekday = weekdayInZone(localNoonUtc, definition.timezone);
  return definition.weekly.filter((item) => item.weekday === actualWeekday).map(({ start, end }) => ({ start, end }));
}

function weekdayInZone(date: Date, timezone: string) {
  const label = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(date);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(label);
}

function formatDateInZone(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const map = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function zonedDateTimeToUtc(date: string, time: string, timezone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const intendedUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = intendedUtc;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
    guess += intendedUtc - represented;
  }
  return new Date(guess);
}

function requiredDateTime(value: unknown, message: string) {
  if (typeof value !== "string" || value.length > 80) throw new V12ValidationError(message);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new V12ValidationError(message);
  return date;
}

function optionalDateTime(value: unknown, fallback: Date) {
  if (!value) return fallback;
  return requiredDateTime(value, "Date invalide.");
}

function normalizeResourceKind(value: unknown): ResourceKind {
  if (value === "user" || value === "team") return value;
  throw new V12ValidationError("Type de ressource invalide.");
}

function normalizeResourceId(value: string) {
  if (!RESOURCE_ID_RE.test(value)) throw new V12ValidationError("Identifiant de ressource invalide.");
  return value;
}

function normalizeIdempotencyKey(value: string) {
  if (!IDEMPOTENCY_RE.test(value)) throw new V12ValidationError("Clé d'idempotence invalide.");
  return value;
}

function normalizeKey(value: unknown, message: string) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,49}$/.test(value)) throw new V12ValidationError(message);
  return value;
}

function normalizeTimezone(value: string) {
  if (value.length < 1 || value.length > 80) throw new V12ValidationError("Fuseau horaire invalide.");
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date()); } catch { throw new V12ValidationError("Fuseau horaire invalide."); }
  return value;
}

function normalizeTime(value: string) {
  if (!TIME_RE.test(value)) throw new V12ValidationError("Heure invalide.");
  return value;
}

function boundedInteger(value: unknown, min: number, max: number, message: string) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new V12ValidationError(message);
  return number;
}

function normalizePublicValue(value: unknown): unknown {
  if (typeof value === "string") return value.trim().slice(0, 4000);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new V12ValidationError("Valeur numérique invalide.");
    return value;
  }
  if (typeof value === "boolean") return value;
  if (Array.isArray(value) && value.length <= 50) return value.map(normalizePublicValue);
  if (value === null) return null;
  throw new V12ValidationError("Valeur publique invalide.");
}

function requestFingerprint(request: Request) {
  const forwarded = (request.headers.get("x-forwarded-for") ?? "unknown").split(",", 1)[0].trim().slice(0, 128);
  const agent = (request.headers.get("user-agent") ?? "unknown").slice(0, 256);
  return createHash("sha256").update(`${forwarded}\n${agent}`).digest("hex");
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function iso(value: Date | string) { return new Date(value).toISOString(); }

function isPgConflict(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "23P01" || code === "23505";
}

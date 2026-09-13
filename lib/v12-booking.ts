import { getPool } from "@/db";
import type { AuthContext } from "@/lib/authz";
import { getCrmRecord } from "@/lib/crm-core";
import { bookAppointment, V12ConflictError } from "@/lib/v12-planning";

type BookingInput = {
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
};

export async function bookAppointmentIdempotent(actor: AuthContext, input: BookingInput) {
  const replay = await findReplay(actor, input);
  if (replay) return replay;
  return bookAppointment(actor, input);
}

async function findReplay(actor: AuthContext, input: BookingInput) {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) return null;
  const result = await getPool().query(
    `SELECT r.appointment_id,r.resource_kind,r.resource_id,r.starts_at,r.ends_at
     FROM planning_reservations r
     JOIN crm_records c ON c.tenant_id=r.tenant_id AND c.id=r.appointment_id
     WHERE r.tenant_id=$1 AND r.idempotency_key=$2 AND c.owner_id=$3
     LIMIT 1`,
    [actor.tenantId, input.idempotencyKey, actor.userId],
  );
  const row = result.rows[0];
  if (!row) return null;

  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  const resourceKind = input.resourceKind ?? "user";
  const resourceId = input.resourceId ?? actor.userId;
  const sameRequest = !Number.isNaN(startsAt.getTime())
    && !Number.isNaN(endsAt.getTime())
    && new Date(row.starts_at).toISOString() === startsAt.toISOString()
    && new Date(row.ends_at).toISOString() === endsAt.toISOString()
    && row.resource_kind === resourceKind
    && row.resource_id === resourceId;
  if (!sameRequest) {
    throw new V12ConflictError("Clé d'idempotence déjà utilisée pour une autre réservation.");
  }
  return getCrmRecord(actor, String(row.appointment_id), "read");
}

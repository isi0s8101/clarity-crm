import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { getDb, getPool } from "@/db";
import { crmConfigurations, webhookDeliveries } from "@/db/schema";
import {
  audit,
  authErrorResponse,
  requirePermission,
  resolveAuthContext,
} from "@/lib/authz";
import { ApiInputError, apiError, parsePagination } from "@/lib/api-response";
import { crmErrorResponse, getCrmRecord } from "@/lib/crm-core";
import { enqueueAutomationJob } from "@/lib/automation-queue";
import type { WebhookEvent } from "@/lib/webhooks";
import { assertSameOriginMutation } from "@/lib/native-auth";

const allowedEvents = new Set<WebhookEvent>([
  "record.created",
  "record.updated",
  "record.archived",
]);
const allowedDeliveryStatuses = new Set(["success", "failure"]);
const allowedDirections = new Set(["outbound", "automation", "inbound"]);

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "webhook", "read");
    const { limit, offset } = parsePagination(request.nextUrl.searchParams);
    const status = request.nextUrl.searchParams.get("status") ?? "";
    const direction = request.nextUrl.searchParams.get("direction") ?? "";
    const webhookId = request.nextUrl.searchParams.get("webhookId") ?? "";
    if (status && !allowedDeliveryStatuses.has(status)) {
      return apiError("Statut de livraison invalide.", 400, "WEBHOOK_STATUS_INVALID");
    }
    if (direction && !allowedDirections.has(direction)) {
      return apiError("Direction de webhook invalide.", 400, "WEBHOOK_DIRECTION_INVALID");
    }
    if (webhookId && !/^[A-Za-z0-9._:-]{1,120}$/.test(webhookId)) {
      return apiError("Identifiant webhook invalide.", 400, "WEBHOOK_ID_INVALID");
    }

    const db = getDb();
    const deliveryFilter = webhookId
      ? status
        ? direction
          ? and(
              eq(webhookDeliveries.tenantId, actor.tenantId),
              eq(webhookDeliveries.webhookId, webhookId),
              eq(webhookDeliveries.status, status),
              eq(webhookDeliveries.direction, direction),
            )
          : and(
              eq(webhookDeliveries.tenantId, actor.tenantId),
              eq(webhookDeliveries.webhookId, webhookId),
              eq(webhookDeliveries.status, status),
            )
        : direction
          ? and(
              eq(webhookDeliveries.tenantId, actor.tenantId),
              eq(webhookDeliveries.webhookId, webhookId),
              eq(webhookDeliveries.direction, direction),
            )
          : and(
              eq(webhookDeliveries.tenantId, actor.tenantId),
              eq(webhookDeliveries.webhookId, webhookId),
            )
      : status
        ? direction
          ? and(
              eq(webhookDeliveries.tenantId, actor.tenantId),
              eq(webhookDeliveries.status, status),
              eq(webhookDeliveries.direction, direction),
            )
          : and(eq(webhookDeliveries.tenantId, actor.tenantId), eq(webhookDeliveries.status, status))
        : direction
          ? and(eq(webhookDeliveries.tenantId, actor.tenantId), eq(webhookDeliveries.direction, direction))
          : eq(webhookDeliveries.tenantId, actor.tenantId);

    const [configs, deliveries, metricRows] = await Promise.all([
      db
        .select()
        .from(crmConfigurations)
        .where(
          and(
            eq(crmConfigurations.tenantId, actor.tenantId),
            eq(crmConfigurations.kind, "webhook"),
          ),
        )
        .orderBy(desc(crmConfigurations.updatedAt))
        .limit(100),
      db
        .select()
        .from(webhookDeliveries)
        .where(deliveryFilter)
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(limit)
        .offset(offset),
      getPool().query(
        "SELECT status, COUNT(*)::int AS count FROM webhook_deliveries WHERE tenant_id=$1 GROUP BY status",
        [actor.tenantId],
      ),
    ]);
    return NextResponse.json({
      configurations: configs.map((config) => ({
        ...config,
        active: config.active === 1,
        definition: safeJson(config.definition),
      })),
      deliveries: deliveries.map((delivery) => ({
        ...delivery,
        requestBody: safeJson(delivery.requestBody),
      })),
      metrics: Object.fromEntries(
        metricRows.rows.map((row) => [String(row.status), Number(row.count)]),
      ),
      pagination: { limit, offset },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof ApiInputError) {
      return apiError(error.message, 400, "PAGINATION_INVALID");
    }
    console.error("webhooks:list", error);
    return apiError("Webhooks indisponibles.", 503, "WEBHOOK_UNAVAILABLE");
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "webhook", "administer");
    const body = (await request.json()) as Record<string, unknown>;
    const recordId = typeof body.recordId === "string" ? body.recordId : "";
    const event = typeof body.event === "string" ? body.event as WebhookEvent : "record.updated";
    if (!allowedEvents.has(event)) {
      return apiError("Événement webhook invalide.", 400, "WEBHOOK_EVENT_INVALID");
    }
    const record = await getCrmRecord(actor, recordId, "read");
    const queued = await enqueueAutomationJob(actor, event, record, {
      idempotencyKey: "manual-webhook:" + actor.userId + ":" + event + ":" + record.id + ":" + crypto.randomUUID(),
    });
    await audit(actor, {
      action: "webhook.dispatched",
      resourceType: record.type,
      resourceId: record.id,
      result: "success",
      details: { event, jobId: queued.id, correlationId: queued.correlationId },
    });
    return NextResponse.json({ queued: queued.queued, jobId: queued.id, correlationId: queued.correlationId }, { status: 202 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    if (error instanceof SyntaxError) {
      return apiError("Corps JSON invalide.", 400, "JSON_INVALID");
    }
    console.error("webhooks:dispatch", error);
    return apiError("Dispatch webhook impossible.", 503, "WEBHOOK_DISPATCH_FAILED");
  }
}

export async function PATCH(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "webhook", "administer");
    const body = (await request.json()) as Record<string, unknown>;
    const deliveryId = typeof body.deliveryId === "string" ? body.deliveryId : "";
    const action = typeof body.action === "string" ? body.action : "";
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(deliveryId)) {
      return apiError("Identifiant de livraison invalide.", 400, "WEBHOOK_DELIVERY_ID_INVALID");
    }
    if (action !== "retry") {
      return apiError("Action webhook invalide.", 400, "WEBHOOK_ACTION_INVALID");
    }

    const db = getDb();
    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.tenantId, actor.tenantId),
          eq(webhookDeliveries.id, deliveryId),
        ),
      )
      .limit(1);
    const delivery = rows[0];
    if (!delivery) {
      return apiError("Livraison webhook introuvable.", 404, "WEBHOOK_DELIVERY_NOT_FOUND");
    }
    if (delivery.direction !== "outbound" || delivery.status !== "failure") {
      return apiError(
        "Seule une livraison sortante en échec peut être relancée.",
        409,
        "WEBHOOK_DELIVERY_STATE_CONFLICT",
        { status: delivery.status, direction: delivery.direction },
      );
    }

    const payload = safeJson(delivery.requestBody) as Record<string, unknown>;
    const record = payload.record as Record<string, unknown> | undefined;
    const event = delivery.event as WebhookEvent;
    if (
      !record
      || !allowedEvents.has(event)
      || record.tenantId !== actor.tenantId
      || typeof record.id !== "string"
      || typeof record.teamId !== "string"
      || typeof record.ownerId !== "string"
      || typeof record.type !== "string"
      || typeof record.title !== "string"
      || typeof record.status !== "string"
      || !record.data
      || typeof record.data !== "object"
      || Array.isArray(record.data)
    ) {
      return apiError("Payload historique incompatible avec une relance sûre.", 409, "WEBHOOK_RETRY_PAYLOAD_INVALID");
    }

    const queued = await enqueueAutomationJob(
      actor,
      event,
      record as {
        id: string;
        tenantId: string;
        teamId: string;
        ownerId: string;
        type: string;
        title: string;
        status: string;
        data: Record<string, unknown>;
        updatedAt?: string;
      },
      {
        mode: "webhook_only",
        webhookId: delivery.webhookId,
        correlationId: crypto.randomUUID(),
        idempotencyKey: `webhook-retry:${delivery.id}:${crypto.randomUUID()}`,
      },
    );
    await audit(actor, {
      action: "webhook.delivery.retried",
      resourceType: "webhook_delivery",
      resourceId: delivery.id,
      result: "success",
      details: {
        webhookId: delivery.webhookId,
        event,
        jobId: queued.id,
        correlationId: queued.correlationId,
      },
    });
    return NextResponse.json(
      { queued: queued.queued, jobId: queued.id, correlationId: queued.correlationId },
      { status: 202 },
    );
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof SyntaxError) {
      return apiError("Corps JSON invalide.", 400, "JSON_INVALID");
    }
    console.error("webhooks:retry", error);
    return apiError("Relance webhook impossible.", 503, "WEBHOOK_RETRY_FAILED");
  }
}

function safeJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

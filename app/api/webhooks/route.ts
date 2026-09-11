import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { crmConfigurations, webhookDeliveries } from "@/db/schema";
import {
  audit,
  authErrorResponse,
  requirePermission,
  resolveAuthContext,
} from "@/lib/authz";
import { crmErrorResponse, getCrmRecord } from "@/lib/crm-core";
import { dispatchOutboundWebhooks, type WebhookEvent } from "@/lib/webhooks";
import { assertSameOriginMutation } from "@/lib/native-auth";

const allowedEvents = new Set<WebhookEvent>([
  "record.created",
  "record.updated",
  "record.archived",
]);

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "webhook", "read");
    const db = getDb();
    const [configs, deliveries] = await Promise.all([
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
        .where(eq(webhookDeliveries.tenantId, actor.tenantId))
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(100),
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
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("webhooks:list", error);
    return NextResponse.json({ error: "Webhooks indisponibles." }, { status: 503 });
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
      return NextResponse.json({ error: "Événement webhook invalide." }, { status: 400 });
    }
    const record = await getCrmRecord(actor, recordId, "read");
    await dispatchOutboundWebhooks(actor, event, record);
    await audit(actor, {
      action: "webhook.dispatched",
      resourceType: record.type,
      resourceId: record.id,
      result: "success",
      details: { event },
    });
    return NextResponse.json({ dispatched: true });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    console.error("webhooks:dispatch", error);
    return NextResponse.json({ error: "Dispatch webhook impossible." }, { status: 503 });
  }
}

function safeJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

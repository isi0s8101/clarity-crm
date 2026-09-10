import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { getDb } from "@/db";
import {
  memberships,
  users,
  webhookDeliveries,
} from "@/db/schema";
import { audit, type AuthContext } from "@/lib/authz";
import { createCrmRecord, crmErrorResponse } from "@/lib/crm-core";
import {
  getInboundWebhookConfiguration,
  verifyWebhookSignature,
} from "@/lib/webhooks";

export async function POST(request: NextRequest) {
  const tenantId = request.headers.get("x-clarity-tenant-id")?.trim() ?? "";
  const key = request.headers.get("x-clarity-webhook-key")?.trim().toLowerCase() ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(tenantId) || !/^[a-z][a-z0-9_-]{0,49}$/.test(key)) {
    return NextResponse.json({ error: "Webhook invalide." }, { status: 400 });
  }

  const rawBody = await request.text();
  if (!rawBody || rawBody.length > 131072) {
    return NextResponse.json({ error: "Payload webhook invalide." }, { status: 400 });
  }

  try {
    const validSignature = await verifyWebhookSignature(
      rawBody,
      request.headers.get("x-clarity-signature"),
      tenantId,
      key,
    );
    if (!validSignature) {
      return NextResponse.json({ error: "Signature webhook invalide." }, { status: 401 });
    }

    const webhook = await getInboundWebhookConfiguration(tenantId, key);
    if (!webhook) {
      return NextResponse.json({ error: "Webhook introuvable." }, { status: 404 });
    }

    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
      payload = parsed as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "JSON webhook invalide." }, { status: 400 });
    }

    const actor = await resolveWebhookActor(tenantId);
    const definition = webhook.definition;
    let createdRecordId: string | null = null;

    if (typeof definition.createType === "string") {
      const titleField = typeof definition.titleField === "string" ? definition.titleField : "title";
      const candidateTitle = payload[titleField];
      const title = typeof candidateTitle === "string" && candidateTitle.trim()
        ? candidateTitle.trim().slice(0, 160)
        : `Webhook ${key}`;
      const record = await createCrmRecord(actor, {
        type: definition.createType,
        title,
        status: "active",
        data: {
          ...payload,
          source: "webhook",
          webhookKey: key,
        },
      });
      createdRecordId = record.id;
    }

    const db = getDb();
    const deliveryId = crypto.randomUUID();
    await db.insert(webhookDeliveries).values({
      id: deliveryId,
      tenantId,
      webhookId: webhook.config.id,
      direction: "inbound",
      event: String(definition.event ?? "external.received").slice(0, 80),
      status: "success",
      requestBody: rawBody,
      responseCode: 202,
      responseBody: createdRecordId ? JSON.stringify({ createdRecordId }) : "{}",
    });
    await audit(actor, {
      action: "webhook.inbound_received",
      resourceType: "webhook",
      resourceId: webhook.config.id,
      result: "success",
      details: { deliveryId, key, createdRecordId },
    });

    return NextResponse.json({ accepted: true, deliveryId, createdRecordId }, { status: 202 });
  } catch (error) {
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    console.error("webhooks:inbound", error);
    return NextResponse.json({ error: "Traitement webhook impossible." }, { status: 503 });
  }
}

async function resolveWebhookActor(tenantId: string): Promise<AuthContext> {
  const db = getDb();
  const adminRows = await db
    .select({
      userId: memberships.userId,
      teamId: memberships.teamId,
      role: memberships.role,
      email: users.email,
      displayName: users.displayName,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        eq(memberships.status, "active"),
        eq(memberships.role, "admin"),
      ),
    )
    .limit(1);

  const row = adminRows[0];
  if (!row?.teamId) throw new Error("Aucun propriétaire actif disponible pour le webhook.");
  return {
    userId: row.userId,
    email: row.email,
    displayName: row.displayName,
    tenantId,
    teamId: row.teamId,
    role: "admin",
  };
}

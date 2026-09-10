import { and, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { crmConfigurations, webhookDeliveries } from "@/db/schema";
import type { AuthContext } from "@/lib/authz";
import { dispatchWebhookRequest, validateWebhookTargetUrl } from "@/lib/webhook-security.js";

export type WebhookEvent = "record.created" | "record.updated" | "record.archived";

type RuntimeRecord = {
  id: string;
  tenantId: string;
  teamId: string;
  ownerId: string;
  type: string;
  title: string;
  status: string;
  data: Record<string, unknown>;
};

export async function dispatchOutboundWebhooks(
  actor: AuthContext,
  event: WebhookEvent,
  record: RuntimeRecord,
) {
  const db = getDb();
  const configs = await db
    .select()
    .from(crmConfigurations)
    .where(
      and(
        eq(crmConfigurations.tenantId, actor.tenantId),
        eq(crmConfigurations.kind, "webhook"),
        eq(crmConfigurations.active, 1),
      ),
    )
    .limit(20);

  for (const config of configs) {
    const definition = parseDefinition(config.definition);
    if (!definition || definition.direction !== "outbound" || definition.event !== event) continue;
    if (typeof definition.key !== "string" || typeof definition.url !== "string") continue;

    const deliveryId = crypto.randomUUID();
    const allowPrivate = readEnv("CLARITY_WEBHOOK_ALLOW_PRIVATE_E2E") === "1";
    const payload = JSON.stringify({
      id: deliveryId,
      event,
      tenantId: actor.tenantId,
      occurredAt: new Date().toISOString(),
      record,
    });

    let urlPolicy;
    try {
      urlPolicy = await validateWebhookTargetUrl(definition.url, {
        allowPrivate,
        allowedHosts: readEnv("CLARITY_WEBHOOK_ALLOWED_HOSTS"),
      });
    } catch (error) {
      await saveDelivery({
        id: deliveryId,
        tenantId: actor.tenantId,
        webhookId: config.id,
        direction: "outbound",
        event,
        status: "failure",
        requestBody: payload,
        error: error instanceof Error ? error.message.slice(0, 2000) : "Validation webhook impossible.",
      });
      continue;
    }

    if (!urlPolicy.ok) {
      await saveDelivery({
        id: deliveryId,
        tenantId: actor.tenantId,
        webhookId: config.id,
        direction: "outbound",
        event,
        status: "failure",
        requestBody: payload,
        error: urlPolicy.error,
      });
      continue;
    }

    try {
      const secret = await deriveWebhookSecret(actor.tenantId, definition.key);
      const signature = await signBody(payload, secret);
      const response = await dispatchWebhookRequest(urlPolicy, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "ClarityCRM-Webhook/1.0",
          "x-clarity-event": event,
          "x-clarity-delivery": deliveryId,
          "x-clarity-signature": `sha256=${signature}`,
        },
        body: payload,
        timeoutMs: 5000,
        responseLimitBytes: 4096,
      });
      await saveDelivery({
        id: deliveryId,
        tenantId: actor.tenantId,
        webhookId: config.id,
        direction: "outbound",
        event,
        status: response.ok ? "success" : "failure",
        requestBody: payload,
        responseCode: response.status,
        responseBody: response.responseText,
        error: response.ok ? "" : `HTTP ${response.status}`,
      });
    } catch (error) {
      await saveDelivery({
        id: deliveryId,
        tenantId: actor.tenantId,
        webhookId: config.id,
        direction: "outbound",
        event,
        status: "failure",
        requestBody: payload,
        error: error instanceof Error ? error.message.slice(0, 2000) : "Échec de livraison webhook.",
      });
    }
  }
}

export async function getInboundWebhookConfiguration(
  tenantId: string,
  key: string,
) {
  const db = getDb();
  const rows = await db
    .select()
    .from(crmConfigurations)
    .where(
      and(
        eq(crmConfigurations.tenantId, tenantId),
        eq(crmConfigurations.kind, "webhook"),
        eq(crmConfigurations.active, 1),
      ),
    )
    .limit(100);

  for (const row of rows) {
    const definition = parseDefinition(row.definition);
    if (definition?.direction === "inbound" && definition.key === key) {
      return { config: row, definition };
    }
  }
  return null;
}

export async function deriveWebhookSecret(tenantId: string, key: string) {
  const master = readEnv("CLARITY_WEBHOOK_MASTER_SECRET");
  if (!master || master.length < 32) {
    throw new Error("CLARITY_WEBHOOK_MASTER_SECRET doit contenir au moins 32 caractères.");
  }
  return hmacHex(master, `clarity-webhook:${tenantId}:${key}`);
}

export async function verifyWebhookSignature(
  body: string,
  signatureHeader: string | null,
  tenantId: string,
  key: string,
) {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const supplied = signatureHeader.slice("sha256=".length).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(supplied)) return false;
  const secret = await deriveWebhookSecret(tenantId, key);
  const expected = await signBody(body, secret);
  return constantTimeHexEqual(supplied, expected);
}

async function signBody(body: string, secret: string) {
  return hmacHex(secret, body);
}

async function hmacHex(secret: string, data: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeHexEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function parseDefinition(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readEnv(name: string) {
  return process.env[name];
}

async function saveDelivery(input: {
  id: string;
  tenantId: string;
  webhookId: string;
  direction: string;
  event: string;
  status: string;
  requestBody: string;
  responseCode?: number;
  responseBody?: string;
  error?: string;
}) {
  const db = getDb();
  await db.insert(webhookDeliveries).values({
    id: input.id,
    tenantId: input.tenantId,
    webhookId: input.webhookId,
    direction: input.direction,
    event: input.event,
    status: input.status,
    requestBody: input.requestBody.slice(0, 131072),
    responseCode: input.responseCode,
    responseBody: (input.responseBody ?? "").slice(0, 4096),
    error: (input.error ?? "").slice(0, 2000),
  });
}

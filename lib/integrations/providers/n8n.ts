import { createHmac } from "node:crypto";

import {
  ConnectorError,
  type Connector,
  type ConnectorHealth,
  type ConnectorRuntimeContext,
  type IntegrationCapability,
  type PushResult,
} from "@/lib/integrations/connector";
import {
  dispatchWebhookRequest,
  validateWebhookTargetUrl,
} from "@/lib/webhook-security.js";

const CAPABILITIES: readonly IntegrationCapability[] = ["webhook.outbound"];

export const n8nConnector: Connector = {
  metadata() {
    return {
      provider: "n8n",
      label: "n8n",
      category: "automation",
      authorization: "webhook",
      documentationUrl: "https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/",
    };
  },
  capabilities() {
    return CAPABILITIES;
  },
  validateConfiguration(configuration) {
    validateConfiguredUrl(configuration.webhookUrl, "URL webhook n8n");
    if (configuration.healthUrl !== undefined && configuration.healthUrl !== "") {
      validateConfiguredUrl(configuration.healthUrl, "URL health n8n");
    }
    if (configuration.allowedHosts !== undefined
      && typeof configuration.allowedHosts !== "string"
      && !Array.isArray(configuration.allowedHosts)) {
      throw new ConnectorError("Allowlist n8n invalide.", { code: "invalid_configuration" });
    }
  },
  async testConnection(context) {
    this.validateConfiguration(context.connection.configuration);
    const healthUrl = String(context.connection.configuration.healthUrl ?? "").trim();
    const webhookUrl = String(context.connection.configuration.webhookUrl ?? "").trim();
    const started = Date.now();
    const target = await validateTarget(context, healthUrl || webhookUrl);
    if (!target.ok) return failedHealth("n8n_target_rejected", target.error, Date.now() - started);
    if (!healthUrl) {
      return {
        ok: true,
        status: "healthy",
        code: "n8n_target_validated",
        message: "Cible n8n validée. Aucun endpoint health n'est configuré, aucun workflow n'a été déclenché.",
        latencyMs: Date.now() - started,
      };
    }
    const response = await dispatchWebhookRequest(target, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": "Clarity-CRM-Integration/1.3" },
      timeoutMs: 10_000,
      responseLimitBytes: 4096,
    });
    if (!response.ok) {
      return failedHealth("n8n_health_failed", `n8n répond HTTP ${response.status}.`, Date.now() - started);
    }
    return {
      ok: true,
      status: "healthy",
      code: "ok",
      message: "Connexion n8n opérationnelle.",
      latencyMs: Date.now() - started,
    };
  },
  async push(context, resourceType, value) {
    this.validateConfiguration(context.connection.configuration);
    if (!context.connection.capabilities.includes("webhook.outbound")) {
      throw new ConnectorError("Capacité webhook sortant non activée.", { code: "n8n_capability_not_enabled" });
    }
    const target = await validateTarget(context, String(context.connection.configuration.webhookUrl));
    if (!target.ok) throw new ConnectorError(target.error, { code: "n8n_target_rejected" });
    const secret = await context.getSecret("webhook_secret");
    if (!secret) throw new ConnectorError("Secret webhook n8n absent.", { code: "n8n_secret_missing", authRequired: true });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const eventId = crypto.randomUUID();
    const body = JSON.stringify({
      version: 1,
      eventId,
      correlationId: context.correlationId,
      connectionId: context.connection.id,
      tenantId: context.connection.tenantId,
      resourceType,
      data: value,
      sentAt: new Date().toISOString(),
    });
    if (Buffer.byteLength(body, "utf8") > 131072) {
      throw new ConnectorError("Payload n8n trop volumineux.", { code: "n8n_payload_too_large" });
    }
    const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
    const response = await dispatchWebhookRequest(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "Clarity-CRM-Integration/1.3",
        "x-clarity-event-id": eventId,
        "x-clarity-timestamp": timestamp,
        "x-clarity-signature": `sha256=${signature}`,
      },
      body,
      timeoutMs: 15_000,
      responseLimitBytes: 8192,
    });
    if (!response.ok) {
      throw new ConnectorError(`n8n répond HTTP ${response.status}.`, {
        code: "n8n_delivery_failed",
        retryable: response.status >= 500 || response.status === 408 || response.status === 429,
        rateLimited: response.status === 429,
      });
    }
    return { externalId: eventId } satisfies PushResult;
  },
  normalizeError(error) {
    if (error instanceof ConnectorError) return error;
    return new ConnectorError(error instanceof Error ? error.message : "Erreur n8n inconnue.", {
      code: "n8n_error",
      retryable: true,
    });
  },
};

async function validateTarget(context: ConnectorRuntimeContext, value: string) {
  const configuration = context.connection.configuration;
  const allowPrivate = process.env.CLARITY_N8N_ALLOW_PRIVATE === "1" && configuration.allowPrivate === true;
  const configuredHosts = configuration.allowedHosts;
  const environmentHosts = String(process.env.CLARITY_N8N_ALLOWED_HOSTS ?? "").trim();
  const allowedHosts = configuredHosts ?? (environmentHosts || undefined);
  if (allowPrivate && !allowedHosts) {
    return { ok: false as const, error: "Une allowlist d'hôtes est obligatoire pour autoriser une cible n8n privée." };
  }
  return validateWebhookTargetUrl(value, { allowPrivate, allowedHosts: allowedHosts as string | string[] | undefined });
}

function validateConfiguredUrl(value: unknown, label: string) {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048) {
    throw new ConnectorError(`${label} invalide.`, { code: "invalid_configuration" });
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new ConnectorError(`${label} invalide.`, { code: "invalid_configuration" }); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new ConnectorError(`${label} doit utiliser HTTPS sans credentials dans l'URL.`, { code: "invalid_configuration" });
  }
}
function failedHealth(code: string, message: string, latencyMs?: number): ConnectorHealth {
  return { ok: false, status: "failed", code, message, latencyMs };
}

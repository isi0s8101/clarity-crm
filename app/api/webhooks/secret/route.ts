import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { crmConfigurations } from "@/db/schema";
import {
  authErrorResponse,
  requirePermission,
  resolveAuthContext,
} from "@/lib/authz";
import { apiError } from "@/lib/api-response";
import { deriveWebhookSecret } from "@/lib/webhooks";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "webhook", "administer");
    const key = request.nextUrl.searchParams.get("key") ?? "";
    if (!/^[a-z][a-z0-9_-]{0,49}$/.test(key)) {
      return apiError("Clé webhook invalide.", 400, "WEBHOOK_KEY_INVALID");
    }

    const db = getDb();
    const configs = await db
      .select({ id: crmConfigurations.id, definition: crmConfigurations.definition })
      .from(crmConfigurations)
      .where(
        and(
          eq(crmConfigurations.tenantId, actor.tenantId),
          eq(crmConfigurations.kind, "webhook"),
          eq(crmConfigurations.active, 1),
        ),
      )
      .limit(100);
    const exists = configs.some((config) => {
      try {
        const definition = JSON.parse(config.definition) as { key?: unknown };
        return definition.key === key;
      } catch {
        return false;
      }
    });
    if (!exists) {
      return apiError("Webhook introuvable.", 404, "WEBHOOK_NOT_FOUND");
    }

    const secret = await deriveWebhookSecret(actor.tenantId, key);
    const fingerprint = await sha256Hex(secret);
    return NextResponse.json(
      {
        key,
        secret: "********",
        masked: true,
        fingerprint: `sha256:${fingerprint.slice(0, 16)}`,
        algorithm: "HMAC-SHA256",
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("webhooks:secret", error);
    return apiError("Métadonnées du secret webhook indisponibles.", 503, "WEBHOOK_SECRET_METADATA_UNAVAILABLE");
  }
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

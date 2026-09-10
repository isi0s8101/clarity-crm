import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { crmConfigurations } from "@/db/schema";
import {
  authErrorResponse,
  requirePermission,
  resolveAuthContext,
} from "@/lib/authz";
import { deriveWebhookSecret } from "@/lib/webhooks";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "webhook", "administer");
    const key = request.nextUrl.searchParams.get("key") ?? "";
    if (!/^[a-z][a-z0-9_-]{0,49}$/.test(key)) {
      return NextResponse.json({ error: "Clé webhook invalide." }, { status: 400 });
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
    if (!exists) return NextResponse.json({ error: "Webhook introuvable." }, { status: 404 });

    const secret = await deriveWebhookSecret(actor.tenantId, key);
    return NextResponse.json(
      { key, secret, algorithm: "HMAC-SHA256" },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("webhooks:secret", error);
    return NextResponse.json({ error: "Secret webhook indisponible." }, { status: 503 });
  }
}

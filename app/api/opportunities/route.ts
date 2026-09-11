import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { opportunities } from "@/db/schema";
import {
  audit,
  authErrorResponse,
  canUseResource,
  requirePermission,
  resolveAuthContext,
} from "@/lib/authz";
import { assertSameOriginMutation } from "@/lib/native-auth";

const allowedStages = new Set([
  "qualification",
  "decouverte",
  "proposition",
  "negociation",
  "gagne",
]);

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    const scope = await requirePermission(actor, "opportunity", "read");
    const db = getDb();
    const rows = await db
      .select()
      .from(opportunities)
      .where(eq(opportunities.tenantId, actor.tenantId))
      .orderBy(desc(opportunities.updatedAt));

    const visible = rows.filter((row) => canUseResource(actor, scope, row));
    return NextResponse.json({ items: visible });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("opportunities:list", error);
    return NextResponse.json(
      { items: [], error: "Les données enregistrées sont momentanément indisponibles." },
      { status: 503 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "opportunity", "create");
    const body = (await request.json()) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const company = typeof body.company === "string" ? body.company.trim() : "";
    const amount = Number(body.amount);
    const stage = typeof body.stage === "string" ? body.stage : "qualification";

    if (!name || !company || !Number.isFinite(amount) || amount <= 0 || !allowedStages.has(stage)) {
      return NextResponse.json({ error: "Données invalides." }, { status: 400 });
    }

    const db = getDb();
    const inserted = await db
      .insert(opportunities)
      .values({
        tenantId: actor.tenantId,
        teamId: actor.teamId,
        name: name.slice(0, 100),
        company: company.slice(0, 100),
        amount: Math.round(amount),
        stage,
        ownerId: actor.userId,
        ownerEmail: actor.email,
      })
      .returning();

    const created = inserted[0];
    await audit(actor, {
      action: "opportunity.created",
      resourceType: "opportunity",
      resourceId: String(created.id),
      result: "success",
      after: created,
      details: { name: created.name, stage: created.stage },
    });

    return NextResponse.json({ item: created }, { status: 201 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("opportunities:create", error);
    return NextResponse.json({ error: "Enregistrement impossible." }, { status: 503 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const scope = await requirePermission(actor, "opportunity", "update");
    const body = (await request.json()) as Record<string, unknown>;
    const id = Number(body.id);
    const stage = typeof body.stage === "string" ? body.stage : "";
    if (!Number.isInteger(id) || id < 1 || !allowedStages.has(stage)) {
      return NextResponse.json({ error: "Mise à jour invalide." }, { status: 400 });
    }

    const db = getDb();
    const existing = await db
      .select()
      .from(opportunities)
      .where(and(eq(opportunities.id, id), eq(opportunities.tenantId, actor.tenantId)))
      .limit(1);

    if (!existing[0]) {
      return NextResponse.json({ error: "Opportunité introuvable." }, { status: 404 });
    }

    if (!canUseResource(actor, scope, existing[0])) {
      await audit(actor, {
        action: "opportunity.stage_change_denied",
        resourceType: "opportunity",
        resourceId: String(id),
        result: "denied",
        before: existing[0],
        details: { requestedStage: stage },
      });
      return NextResponse.json({ error: "Autorisation insuffisante." }, { status: 403 });
    }

    const updated = await db
      .update(opportunities)
      .set({ stage, updatedAt: new Date().toISOString() })
      .where(and(eq(opportunities.id, id), eq(opportunities.tenantId, actor.tenantId)))
      .returning();

    if (!updated[0]) {
      return NextResponse.json({ error: "Opportunité introuvable." }, { status: 404 });
    }

    await audit(actor, {
      action: "opportunity.stage_changed",
      resourceType: "opportunity",
      resourceId: String(id),
      result: "success",
      before: existing[0],
      after: updated[0],
      details: { stage },
    });

    return NextResponse.json({ item: updated[0] });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("opportunities:update", error);
    return NextResponse.json({ error: "Mise à jour impossible." }, { status: 503 });
  }
}

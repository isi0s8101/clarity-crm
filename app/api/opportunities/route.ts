import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditEvents, opportunities } from "@/db/schema";

const allowedStages = new Set([
  "qualification",
  "decouverte",
  "proposition",
  "negociation",
  "gagne",
]);

function identity(request: NextRequest) {
  return {
    userId: request.headers.get("oai-authenticated-user-id") ?? "workspace-user",
    email:
      request.headers.get("oai-authenticated-user-email") ?? "utilisateur@workspace",
  };
}

export async function GET() {
  try {
    const db = getDb();
    const rows = await db.select().from(opportunities).orderBy(desc(opportunities.updatedAt));
    return NextResponse.json({ items: rows });
  } catch (error) {
    console.error("opportunities:list", error);
    return NextResponse.json(
      { items: [], error: "Les données enregistrées sont momentanément indisponibles." },
      { status: 503 },
    );
  }
}

export async function POST(request: NextRequest) {
  const actor = identity(request);
  try {
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
        name: name.slice(0, 100),
        company: company.slice(0, 100),
        amount: Math.round(amount),
        stage,
        ownerId: actor.userId,
        ownerEmail: actor.email,
      })
      .returning();

    const created = inserted[0];
    await db.insert(auditEvents).values({
      actorId: actor.userId,
      actorEmail: actor.email,
      action: "opportunity.created",
      entityType: "opportunity",
      entityId: String(created.id),
      details: JSON.stringify({ name: created.name, stage: created.stage }),
    });

    return NextResponse.json({ item: created }, { status: 201 });
  } catch (error) {
    console.error("opportunities:create", error);
    return NextResponse.json({ error: "Enregistrement impossible." }, { status: 503 });
  }
}

export async function PATCH(request: NextRequest) {
  const actor = identity(request);
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const id = Number(body.id);
    const stage = typeof body.stage === "string" ? body.stage : "";
    if (!Number.isInteger(id) || id < 1 || !allowedStages.has(stage)) {
      return NextResponse.json({ error: "Mise à jour invalide." }, { status: 400 });
    }

    const db = getDb();
    const updated = await db
      .update(opportunities)
      .set({ stage, updatedAt: new Date().toISOString() })
      .where(eq(opportunities.id, id))
      .returning();

    if (!updated[0]) {
      return NextResponse.json({ error: "Opportunité introuvable." }, { status: 404 });
    }

    await db.insert(auditEvents).values({
      actorId: actor.userId,
      actorEmail: actor.email,
      action: "opportunity.stage_changed",
      entityType: "opportunity",
      entityId: String(id),
      details: JSON.stringify({ stage }),
    });

    return NextResponse.json({ item: updated[0] });
  } catch (error) {
    console.error("opportunities:update", error);
    return NextResponse.json({ error: "Mise à jour impossible." }, { status: 503 });
  }
}

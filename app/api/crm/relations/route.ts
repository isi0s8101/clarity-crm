import { NextRequest, NextResponse } from "next/server";
import { and, eq, or } from "drizzle-orm";

import { getDb } from "@/db";
import { crmRelations } from "@/db/schema";
import {
  audit,
  authErrorResponse,
  canUseResource,
  requirePermission,
  resolveAuthContext,
} from "@/lib/authz";
import {
  appendTimeline,
  crmErrorResponse,
  getCrmRecord,
} from "@/lib/crm-core";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    const recordId = request.nextUrl.searchParams.get("recordId") ?? "";
    const record = await getCrmRecord(actor, recordId, "read");
    const scope = await requirePermission(actor, "crm_relation", "read");
    if (!canUseResource(actor, scope, record)) {
      return NextResponse.json({ items: [] });
    }

    const db = getDb();
    const rows = await db
      .select()
      .from(crmRelations)
      .where(
        and(
          eq(crmRelations.tenantId, actor.tenantId),
          or(
            eq(crmRelations.fromRecordId, recordId),
            eq(crmRelations.toRecordId, recordId),
          ),
        ),
      )
      .limit(100);

    const items = [];
    for (const relation of rows) {
      const relatedId = relation.fromRecordId === recordId
        ? relation.toRecordId
        : relation.fromRecordId;
      try {
        const related = await getCrmRecord(actor, relatedId, "read");
        items.push({ relation, related });
      } catch {
        // Ne révèle jamais l'existence d'une ressource hors périmètre.
      }
    }
    return NextResponse.json({ items });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    console.error("crm:relations:list", error);
    return NextResponse.json({ error: "Relations indisponibles." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "crm_relation", "create");
    const body = (await request.json()) as Record<string, unknown>;
    const fromId = typeof body.fromId === "string" ? body.fromId : "";
    const toId = typeof body.toId === "string" ? body.toId : "";
    const relationType = normalizeRelationType(body.relationType);
    if (!fromId || !toId || fromId === toId || !relationType) {
      return NextResponse.json({ error: "Relation invalide." }, { status: 400 });
    }

    const from = await getCrmRecord(actor, fromId, "read");
    const to = await getCrmRecord(actor, toId, "read");
    if (from.tenantId !== to.tenantId || from.tenantId !== actor.tenantId) {
      return NextResponse.json({ error: "Relation cross-tenant interdite." }, { status: 400 });
    }

    const db = getDb();
    const existing = await db
      .select({ id: crmRelations.id })
      .from(crmRelations)
      .where(
        and(
          eq(crmRelations.tenantId, actor.tenantId),
          eq(crmRelations.fromRecordId, fromId),
          eq(crmRelations.toRecordId, toId),
          eq(crmRelations.relationType, relationType),
        ),
      )
      .limit(1);
    if (existing[0]) {
      return NextResponse.json({ error: "Relation déjà existante." }, { status: 409 });
    }

    const inserted = await db.insert(crmRelations).values({
      id: crypto.randomUUID(),
      tenantId: actor.tenantId,
      fromRecordId: fromId,
      toRecordId: toId,
      relationType,
      createdBy: actor.userId,
    }).returning();

    await appendTimeline(actor, from, "relation.created", `${from.title} relié à ${to.title}`, {
      relatedRecordId: to.id,
      relationType,
    });
    await appendTimeline(actor, to, "relation.created", `${to.title} relié à ${from.title}`, {
      relatedRecordId: from.id,
      relationType,
    });
    await audit(actor, {
      action: "crm_relation.created",
      resourceType: "crm_relation",
      resourceId: inserted[0].id,
      result: "success",
      after: inserted[0],
    });
    return NextResponse.json({ item: inserted[0] }, { status: 201 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    console.error("crm:relations:create", error);
    return NextResponse.json({ error: "Création de relation impossible." }, { status: 503 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    const scope = await requirePermission(actor, "crm_relation", "delete");
    const id = request.nextUrl.searchParams.get("id") ?? "";
    const db = getDb();
    const rows = await db
      .select()
      .from(crmRelations)
      .where(and(eq(crmRelations.id, id), eq(crmRelations.tenantId, actor.tenantId)))
      .limit(1);
    if (!rows[0]) return NextResponse.json({ error: "Relation introuvable." }, { status: 404 });

    const from = await getCrmRecord(actor, rows[0].fromRecordId, "read");
    if (!canUseResource(actor, scope, from)) {
      return NextResponse.json({ error: "Relation introuvable." }, { status: 404 });
    }
    await db.delete(crmRelations).where(and(eq(crmRelations.id, id), eq(crmRelations.tenantId, actor.tenantId)));
    await audit(actor, {
      action: "crm_relation.deleted",
      resourceType: "crm_relation",
      resourceId: id,
      result: "success",
      before: rows[0],
    });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    console.error("crm:relations:delete", error);
    return NextResponse.json({ error: "Suppression de relation impossible." }, { status: 503 });
  }
}

function normalizeRelationType(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[a-z][a-z0-9_.:-]{0,79}$/.test(normalized) ? normalized : null;
}

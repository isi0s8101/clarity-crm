import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { opportunities } from "@/db/schema";
import {
  audit,
  authErrorResponse,
  canUseResource,
  requirePermission,
  resolveAuthContext,
} from "@/lib/authz";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    const scope = await requirePermission(actor, "opportunity", "export");
    const db = getDb();
    const rows = await db
      .select()
      .from(opportunities)
      .where(eq(opportunities.tenantId, actor.tenantId))
      .orderBy(desc(opportunities.updatedAt));

    const visibleRows = rows.filter((row) => canUseResource(actor, scope, row));
    const csv = [
      ["id", "nom", "societe", "montant", "etape", "responsable", "tenant", "equipe"],
      ...visibleRows.map((row) => [
        row.id,
        row.name,
        row.company,
        row.amount,
        row.stage,
        row.ownerEmail,
        row.tenantId,
        row.teamId,
      ]),
    ]
      .map((line) => line.map(escapeCsv).join(","))
      .join("\n");

    await audit(actor, {
      action: "opportunity.exported",
      resourceType: "opportunity",
      resourceId: "bulk",
      result: "success",
      details: { count: visibleRows.length, scope },
    });

    return new NextResponse(`\uFEFF${csv}`, {
      headers: {
        "content-type": "text/csv;charset=utf-8",
        "content-disposition": 'attachment; filename="opportunites-clarity-crm.csv"',
      },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("opportunities:export", error);
    return NextResponse.json({ error: "Export indisponible." }, { status: 503 });
  }
}

function escapeCsv(value: string | number) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

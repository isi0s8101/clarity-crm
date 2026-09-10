import { NextRequest } from "next/server";

import { authErrorResponse, resolveAuthContext } from "@/lib/authz";
import { crmErrorResponse, listCrmRecords } from "@/lib/crm-core";

export const runtime = "nodejs";

function csv(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    const type = request.nextUrl.searchParams.get("type") ?? "";
    const status = request.nextUrl.searchParams.get("status");
    const q = request.nextUrl.searchParams.get("q");
    const rows = await listCrmRecords(actor, { type, status, q, limit: 100, offset: 0 });
    const lines = [
      ["id", "type", "title", "status", "ownerId", "teamId", "createdAt", "updatedAt", "data"].map(csv).join(","),
      ...rows.map((row) => [
        row.id,
        row.type,
        row.title,
        row.status,
        row.ownerId,
        row.teamId,
        row.createdAt,
        row.updatedAt,
        row.data,
      ].map(csv).join(",")),
    ];
    const filename = `clarity-${type.replace(/[^A-Za-z0-9_-]/g, "_") || "crm"}.csv`;
    return new Response(`\uFEFF${lines.join("\r\n")}\r\n`, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    console.error("crm:export", error);
    return Response.json({ error: "Export CRM indisponible." }, { status: 503 });
  }
}

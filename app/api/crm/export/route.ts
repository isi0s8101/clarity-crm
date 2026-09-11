import { NextRequest } from "next/server";

import { authErrorResponse, resolveAuthContext } from "@/lib/authz";
import { crmErrorResponse, listCrmRecords } from "@/lib/crm-core";
import { createXlsx, safeSpreadsheetValue } from "@/lib/xlsx";

export const runtime = "nodejs";

function csv(value: unknown) {
  const text = safeSpreadsheetValue(typeof value === "string" ? value : JSON.stringify(value));
  return `"${text.replaceAll('"', '""')}"`;
}

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    const type = request.nextUrl.searchParams.get("type") ?? "";
    const status = request.nextUrl.searchParams.get("status");
    const q = request.nextUrl.searchParams.get("q");
    const format = request.nextUrl.searchParams.get("format") === "xlsx" ? "xlsx" : "csv";
    const rows = await listCrmRecords(actor, { type, status, q, limit: 1000, offset: 0, action: "export" });
    const values = [
      ["id", "type", "title", "status", "ownerId", "teamId", "createdAt", "updatedAt", "data"],
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
      ]),
    ];
    const filenameBase = `clarity-${type.replace(/[^A-Za-z0-9_-]/g, "_") || "crm"}`;
    if (format === "xlsx") {
      return new Response(createXlsx(values), {
        headers: {
          "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "content-disposition": `attachment; filename="${filenameBase}.xlsx"`,
          "cache-control": "no-store",
        },
      });
    }
    return new Response(`\uFEFF${values.map((row) => row.map(csv).join(",")).join("\r\n")}\r\n`, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filenameBase}.csv"`,
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

import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, resolveAuthContext } from "@/lib/authz";
import { listCrmRecords, crmErrorResponse } from "@/lib/crm-core";
import { CORE_RECORD_TYPES } from "@/lib/crm-policy.js";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
    if (q.length < 2) {
      return NextResponse.json({ error: "La recherche doit contenir au moins 2 caractères." }, { status: 400 });
    }
    const requestedLimit = Number(request.nextUrl.searchParams.get("limit") ?? "50");
    const limit = Number.isInteger(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : 50;
    const perType = Math.max(5, Math.ceil(limit / CORE_RECORD_TYPES.length) + 2);

    const results = await Promise.all(
      CORE_RECORD_TYPES.map(async (type) => {
        try {
          return await listCrmRecords(actor, { type, q: q.slice(0, 80), limit: perType, offset: 0 });
        } catch {
          return [];
        }
      }),
    );
    const items = results
      .flat()
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, limit);
    return NextResponse.json({ items, q: q.slice(0, 80), limit });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    console.error("crm:search", error);
    return NextResponse.json({ error: "Recherche CRM indisponible." }, { status: 503 });
  }
}

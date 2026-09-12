import { NextRequest, NextResponse } from "next/server";

import {
  archiveCrmRecord,
  createCrmRecord,
  crmErrorResponse,
  getCrmRecord,
  listCrmRecords,
  updateCrmRecord,
} from "@/lib/crm-core";
import { authErrorResponse, resolveAuthContext } from "@/lib/authz";
import { CrmFilterValidationError, parseCrmFilters } from "@/lib/crm-filter-policy.js";
import type { CrmFilterGroup } from "@/lib/crm-filter-types";
import { assertSameOriginMutation } from "@/lib/native-auth";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    const id = request.nextUrl.searchParams.get("id");
    if (id) {
      const item = await getCrmRecord(actor, id, "read");
      return NextResponse.json({ item });
    }

    const type = request.nextUrl.searchParams.get("type") ?? "";
    const status = request.nextUrl.searchParams.get("status");
    const q = request.nextUrl.searchParams.get("q");
    const filtersParam = request.nextUrl.searchParams.get("filters");
    let filters: CrmFilterGroup | undefined;
    if (filtersParam) {
      try {
        filters = parseCrmFilters(JSON.parse(filtersParam) as unknown) as CrmFilterGroup;
      } catch (error) {
        throw error instanceof CrmFilterValidationError ? error : new CrmFilterValidationError("Filtres CRM invalides.");
      }
    }
    const limit = toInteger(request.nextUrl.searchParams.get("limit"), 50);
    const offset = toInteger(request.nextUrl.searchParams.get("offset"), 0);
    const items = await listCrmRecords(actor, { type, status, q, filters, limit, offset });
    return NextResponse.json({ items, limit, offset });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    console.error("crm:list", error);
    return NextResponse.json({ error: "CRM indisponible." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const body = (await request.json()) as Record<string, unknown>;
    const item = await createCrmRecord(actor, body);
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    console.error("crm:create", error);
    return NextResponse.json({ error: "Création CRM impossible." }, { status: 503 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const body = (await request.json()) as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id : "";
    const item = await updateCrmRecord(actor, id, body);
    return NextResponse.json({ item });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    console.error("crm:update", error);
    return NextResponse.json({ error: "Mise à jour CRM impossible." }, { status: 503 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const id = request.nextUrl.searchParams.get("id") ?? "";
    const item = await archiveCrmRecord(actor, id);
    return NextResponse.json({ item });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    console.error("crm:archive", error);
    return NextResponse.json({ error: "Archivage CRM impossible." }, { status: 503 });
  }
}

function toInteger(value: string | null, fallback: number) {
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

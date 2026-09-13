import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, resolveAuthContext } from "@/lib/authz";
import { crmErrorResponse } from "@/lib/crm-core";
import { detectDuplicates } from "@/lib/v12-duplicates";
import { v12ErrorResponse } from "@/lib/v12-planning";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    const recordId = request.nextUrl.searchParams.get("recordId") ?? "";
    return NextResponse.json(await detectDuplicates(actor, recordId));
  } catch (error) {
    const auth = authErrorResponse(error); if (auth) return auth;
    const crm = crmErrorResponse(error); if (crm) return crm;
    const v12 = v12ErrorResponse(error); if (v12) return v12;
    console.error("duplicates:detect", error);
    return NextResponse.json({ error: "Détection de doublons indisponible." }, { status: 503 });
  }
}

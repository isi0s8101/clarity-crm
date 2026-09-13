import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, resolveAuthContext } from "@/lib/authz";
import { crmErrorResponse } from "@/lib/crm-core";
import { assertSameOriginMutation } from "@/lib/native-auth";
import { calculateScore } from "@/lib/v12-intelligence";
import { readJsonBodyLimited, v12ErrorResponse } from "@/lib/v12-planning";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    const item = await calculateScore(actor, request.nextUrl.searchParams.get("recordId") ?? "", false);
    return NextResponse.json({ item });
  } catch (error) { return handle(error, "scoring:get"); }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const body = await readJsonBodyLimited(request);
    const item = await calculateScore(actor, typeof body.recordId === "string" ? body.recordId : "", true);
    return NextResponse.json({ item });
  } catch (error) { return handle(error, "scoring:recalculate"); }
}

function handle(error: unknown, label: string) {
  const auth = authErrorResponse(error); if (auth) return auth;
  const crm = crmErrorResponse(error); if (crm) return crm;
  const v12 = v12ErrorResponse(error); if (v12) return v12;
  console.error(label, error);
  return NextResponse.json({ error: "Scoring indisponible." }, { status: 503 });
}

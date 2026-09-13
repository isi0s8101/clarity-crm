import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, resolveAuthContext } from "@/lib/authz";
import { crmErrorResponse } from "@/lib/crm-core";
import { assertSameOriginMutation } from "@/lib/native-auth";
import { acceptNextAction, getNextActions } from "@/lib/v12-intelligence";
import { readJsonBodyLimited, v12ErrorResponse } from "@/lib/v12-planning";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    return NextResponse.json(await getNextActions(actor, request.nextUrl.searchParams.get("recordId") ?? ""));
  } catch (error) { return handle(error, "next-actions:list"); }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const body = await readJsonBodyLimited(request);
    const item = await acceptNextAction(
      actor,
      typeof body.recordId === "string" ? body.recordId : "",
      typeof body.recommendationId === "string" ? body.recommendationId : "",
    );
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) { return handle(error, "next-actions:accept"); }
}

function handle(error: unknown, label: string) {
  const auth = authErrorResponse(error); if (auth) return auth;
  const crm = crmErrorResponse(error); if (crm) return crm;
  const v12 = v12ErrorResponse(error); if (v12) return v12;
  console.error(label, error);
  return NextResponse.json({ error: "Next Best Action indisponible." }, { status: 503 });
}

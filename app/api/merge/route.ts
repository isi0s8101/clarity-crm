import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, resolveAuthContext } from "@/lib/authz";
import { crmErrorResponse } from "@/lib/crm-core";
import { assertSameOriginMutation } from "@/lib/native-auth";
import { mergeRecords, previewMerge } from "@/lib/v12-merge";
import { readJsonBodyLimited, v12ErrorResponse } from "@/lib/v12-planning";

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const body = await readJsonBodyLimited(request);
    const primaryId = text(body.primaryId);
    const secondaryId = text(body.secondaryId);
    if (body.intent === "preview") {
      return NextResponse.json({ item: await previewMerge(actor, primaryId, secondaryId) });
    }
    const item = await mergeRecords(actor, {
      primaryId,
      secondaryId,
      resolution: object(body.resolution) ?? undefined,
      confirm: body.confirm === true,
    });
    return NextResponse.json({ item });
  } catch (error) {
    const auth = authErrorResponse(error); if (auth) return auth;
    const crm = crmErrorResponse(error); if (crm) return crm;
    const v12 = v12ErrorResponse(error); if (v12) return v12;
    console.error("merge", error);
    return NextResponse.json({ error: "Fusion indisponible." }, { status: 503 });
  }
}
function text(value: unknown) { return typeof value === "string" ? value : ""; }
function object(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }

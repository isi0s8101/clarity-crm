import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, resolveAuthContext } from "@/lib/authz";
import { listV12Configurations } from "@/lib/v12-config";
import { v12ErrorResponse } from "@/lib/v12-planning";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    const items = await listV12Configurations(actor, request.nextUrl.searchParams.get("kind"));
    return NextResponse.json({ items });
  } catch (error) {
    const auth = authErrorResponse(error); if (auth) return auth;
    const v12 = v12ErrorResponse(error); if (v12) return v12;
    console.error("v12-config:list", error);
    return NextResponse.json({ error: "Configuration v1.2 indisponible." }, { status: 503 });
  }
}

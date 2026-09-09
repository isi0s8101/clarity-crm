import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, resolveAuthContext } from "@/lib/authz";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    return NextResponse.json({
      user: {
        email: actor.email,
        displayName: actor.displayName,
        role: actor.role,
        tenantId: actor.tenantId,
        teamId: actor.teamId,
      },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("session:get", error);
    return NextResponse.json({ error: "Session indisponible." }, { status: 503 });
  }
}

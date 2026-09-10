import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, resolveAuthContext } from "@/lib/authz";
import { normalizeTenantSelector } from "@/lib/authz-policy.js";
import { assertSameOriginMutation, secureCookieForRequest } from "@/lib/native-auth";

const COOKIE_NAME = "clarity_tenant";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const body = (await request.json()) as Record<string, unknown>;
    const tenantId = normalizeTenantSelector(typeof body.tenantId === "string" ? body.tenantId : "");
    if (!tenantId) return NextResponse.json({ error: "Tenant invalide." }, { status: 400 });

    const headers = new Headers(request.headers);
    headers.set("x-clarity-tenant-id", tenantId);
    const actor = await resolveAuthContext({ headers });
    const response = NextResponse.json({
      user: {
        email: actor.email,
        displayName: actor.displayName,
        role: actor.role,
        tenantId: actor.tenantId,
        teamId: actor.teamId,
      },
    });
    response.cookies.set(COOKIE_NAME, actor.tenantId, {
      httpOnly: true,
      sameSite: "strict",
      secure: secureCookieForRequest(request),
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return response;
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("session:tenant-select", error);
    return NextResponse.json({ error: "Sélection du tenant impossible." }, { status: 503 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const response = NextResponse.json({ ok: true });
    response.cookies.set(COOKIE_NAME, "", {
      httpOnly: true,
      sameSite: "strict",
      secure: secureCookieForRequest(request),
      path: "/",
      maxAge: 0,
    });
    return response;
  } catch (error) {
    console.error("session:tenant-clear", error);
    return NextResponse.json({ error: "Réinitialisation impossible." }, { status: 503 });
  }
}

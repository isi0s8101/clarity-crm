import { NextRequest, NextResponse } from "next/server";

import {
  SESSION_COOKIE_NAME,
  assertSameOriginMutation,
  revokeNativeSession,
  safeReturnPath,
  secureCookieForRequest,
} from "@/lib/native-auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await revokeNativeSession(request);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const returnTo = safeReturnPath(body.returnTo);
    const response = NextResponse.json({ ok: true, returnTo });
    response.headers.set("cache-control", "no-store");
    response.cookies.set(SESSION_COOKIE_NAME, "", {
      httpOnly: true,
      sameSite: "strict",
      secure: secureCookieForRequest(request),
      path: "/",
      maxAge: 0,
    });
    response.cookies.set("clarity_tenant", "", {
      httpOnly: true,
      sameSite: "strict",
      secure: secureCookieForRequest(request),
      path: "/",
      maxAge: 0,
    });
    return response;
  } catch (error) {
    console.error("auth:logout", error);
    return NextResponse.json({ error: "Déconnexion impossible." }, { status: 503 });
  }
}

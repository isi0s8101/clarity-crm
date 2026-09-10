import { NextRequest, NextResponse } from "next/server";

import {
  NativeAuthError,
  SESSION_COOKIE_NAME,
  assertSameOriginMutation,
  authenticateNativeCredentials,
  safeReturnPath,
  secureCookieForRequest,
} from "@/lib/native-auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const length = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > 8192) {
      return NextResponse.json({ error: "Requête trop volumineuse." }, { status: 413 });
    }

    const body = (await request.json()) as Record<string, unknown>;
    const result = await authenticateNativeCredentials({
      email: body.email,
      password: body.password,
      userAgent: request.headers.get("user-agent"),
    });
    const returnTo = safeReturnPath(body.returnTo);

    const response = NextResponse.json({
      ok: true,
      returnTo,
      user: { email: result.user.email, displayName: result.user.displayName },
    });
    response.headers.set("cache-control", "no-store");
    response.cookies.set(SESSION_COOKIE_NAME, result.token, {
      httpOnly: true,
      sameSite: "strict",
      secure: secureCookieForRequest(request),
      path: "/",
      expires: new Date(result.expiresAt),
      priority: "high",
    });
    return response;
  } catch (error) {
    if (error instanceof NativeAuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status, headers: { "cache-control": "no-store" } },
      );
    }
    console.error("auth:login", error);
    return NextResponse.json(
      { error: "Authentification indisponible." },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}

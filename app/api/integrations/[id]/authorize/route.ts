import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, resolveAuthContext } from "@/lib/authz";
import { beginIntegrationAuthorization, integrationErrorResponse } from "@/lib/integration-manager";
import { assertSameOriginMutation } from "@/lib/native-auth";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const { id } = await context.params;
    const base = String(process.env.CLARITY_PUBLIC_BASE_URL ?? "").trim() || request.nextUrl.origin;
    const redirectUri = new URL("/api/integrations/oauth/callback", base).toString();
    return NextResponse.json(await beginIntegrationAuthorization(actor, id, redirectUri));
  } catch (error) {
    const auth = authErrorResponse(error); if (auth) return auth;
    const integration = integrationErrorResponse(error); if (integration) return integration;
    console.error("integrations:authorize", error);
    return NextResponse.json({ error: "Autorisation d'intégration indisponible." }, { status: 503 });
  }
}

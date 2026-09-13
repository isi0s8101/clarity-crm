import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, resolveAuthContext } from "@/lib/authz";
import { integrationErrorResponse, revokeIntegrationConnection } from "@/lib/integration-manager";
import { assertSameOriginMutation } from "@/lib/native-auth";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const { id } = await context.params;
    return NextResponse.json({ item: await revokeIntegrationConnection(actor, id) });
  } catch (error) {
    const auth = authErrorResponse(error); if (auth) return auth;
    const integration = integrationErrorResponse(error); if (integration) return integration;
    console.error("integrations:revoke", error);
    return NextResponse.json({ error: "Révocation d'intégration indisponible." }, { status: 503 });
  }
}

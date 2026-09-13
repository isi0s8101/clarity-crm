import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, resolveAuthContext } from "@/lib/authz";
import { getIntegrationHealth, integrationErrorResponse } from "@/lib/integration-manager";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context) {
  try {
    const actor = await resolveAuthContext(request);
    const { id } = await context.params;
    return NextResponse.json(await getIntegrationHealth(actor, id));
  } catch (error) {
    const auth = authErrorResponse(error); if (auth) return auth;
    const integration = integrationErrorResponse(error); if (integration) return integration;
    console.error("integrations:health", error);
    return NextResponse.json({ error: "Santé d'intégration indisponible." }, { status: 503 });
  }
}

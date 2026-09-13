import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, resolveAuthContext } from "@/lib/authz";
import { integrationSyncErrorResponse, getIntegrationSyncRun } from "@/lib/integration-sync";

type Context = { params: Promise<{ id: string; runId: string }> };

export async function GET(request: NextRequest, context: Context) {
  try {
    const actor = await resolveAuthContext(request);
    const { id, runId } = await context.params;
    const item = await getIntegrationSyncRun(actor, runId);
    if (item.connectionId !== id) return NextResponse.json({ error: "Run introuvable." }, { status: 404 });
    return NextResponse.json({ item });
  } catch (error) {
    const auth = authErrorResponse(error); if (auth) return auth;
    const sync = integrationSyncErrorResponse(error); if (sync) return sync;
    console.error("integrations:run", error);
    return NextResponse.json({ error: "Run de synchronisation indisponible." }, { status: 503 });
  }
}

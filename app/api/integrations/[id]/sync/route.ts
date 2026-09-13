import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, resolveAuthContext } from "@/lib/authz";
import { integrationErrorResponse } from "@/lib/integration-manager";
import { integrationMappingErrorResponse } from "@/lib/integration-mappings";
import { requestMappedIntegrationSync } from "@/lib/integration-orchestrator";
import { integrationSyncErrorResponse } from "@/lib/integration-sync";
import { assertSameOriginMutation } from "@/lib/native-auth";
import { readJsonBodyLimited } from "@/lib/v12-planning";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const { id } = await context.params;
    const body = await readJsonBodyLimited(request);
    const result = await requestMappedIntegrationSync(actor, {
      connectionId: id,
      resourceType: text(body.resourceType),
      direction: body.direction === "push" ? "push" : "pull",
      triggerKind: body.triggerKind === "initial" || body.triggerKind === "scheduled" || body.triggerKind === "retry" || body.triggerKind === "webhook" ? body.triggerKind : "manual",
    });
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    const auth = authErrorResponse(error); if (auth) return auth;
    const integration = integrationErrorResponse(error); if (integration) return integration;
    const mapping = integrationMappingErrorResponse(error); if (mapping) return mapping;
    const sync = integrationSyncErrorResponse(error); if (sync) return sync;
    console.error("integrations:sync", error);
    return NextResponse.json({ error: "Synchronisation indisponible." }, { status: 503 });
  }
}
function text(value: unknown) { return typeof value === "string" ? value : ""; }

import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, resolveAuthContext } from "@/lib/authz";
import { integrationErrorResponse } from "@/lib/integration-manager";
import { integrationMappingErrorResponse, resetIntegrationCheckpoint } from "@/lib/integration-mappings";
import { assertSameOriginMutation } from "@/lib/native-auth";
import { readJsonBodyLimited } from "@/lib/v12-planning";

type Context = { params: Promise<{ id: string }> };

export async function DELETE(request: NextRequest, context: Context) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const { id } = await context.params;
    const body = await readJsonBodyLimited(request);
    return NextResponse.json(await resetIntegrationCheckpoint(actor, id, text(body.resourceType)));
  } catch (error) {
    const auth = authErrorResponse(error); if (auth) return auth;
    const integration = integrationErrorResponse(error); if (integration) return integration;
    const mapping = integrationMappingErrorResponse(error); if (mapping) return mapping;
    console.error("integrations:checkpoint", error);
    return NextResponse.json({ error: "Réinitialisation du checkpoint indisponible." }, { status: 503 });
  }
}

function text(value: unknown) { return typeof value === "string" ? value : ""; }

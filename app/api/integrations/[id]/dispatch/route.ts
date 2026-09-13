import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, resolveAuthContext } from "@/lib/authz";
import { dispatchIntegrationAction, integrationActionErrorResponse } from "@/lib/integration-actions";
import { integrationErrorResponse } from "@/lib/integration-manager";
import { assertSameOriginMutation } from "@/lib/native-auth";
import { readJsonBodyLimited } from "@/lib/v12-planning";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const { id } = await context.params;
    const body = await readJsonBodyLimited(request);
    const result = await dispatchIntegrationAction(actor, id, {
      resourceType: text(body.resourceType),
      data: object(body.data),
    });
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    const auth = authErrorResponse(error); if (auth) return auth;
    const integration = integrationErrorResponse(error); if (integration) return integration;
    const action = integrationActionErrorResponse(error); if (action) return action;
    console.error("integrations:dispatch", error);
    return NextResponse.json({ error: "Action d'intégration indisponible." }, { status: 503 });
  }
}
function text(value: unknown) { return typeof value === "string" ? value : ""; }
function object(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

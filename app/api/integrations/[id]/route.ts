import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, resolveAuthContext } from "@/lib/authz";
import { getIntegrationConnection, integrationErrorResponse, updateIntegrationConnection } from "@/lib/integration-manager";
import { assertNoSensitiveIntegrationKeys } from "@/lib/integration-safety.mjs";
import { assertSameOriginMutation } from "@/lib/native-auth";
import { readJsonBodyLimited } from "@/lib/v12-planning";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context) {
  try {
    const actor = await resolveAuthContext(request);
    const { id } = await context.params;
    return NextResponse.json({ item: await getIntegrationConnection(actor, id) });
  } catch (error) { return handle(error, "integrations:get"); }
}

export async function PATCH(request: NextRequest, context: Context) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const { id } = await context.params;
    const body = await readJsonBodyLimited(request);
    const configuration = body.configuration === undefined ? undefined : object(body.configuration);
    const syncPolicy = body.syncPolicy === undefined ? undefined : object(body.syncPolicy);
    if (configuration) assertNoSensitiveIntegrationKeys(configuration, "Configuration");
    if (syncPolicy) assertNoSensitiveIntegrationKeys(syncPolicy, "Politique de synchronisation");
    const item = await updateIntegrationConnection(actor, id, {
      name: optionalText(body.name),
      capabilities: body.capabilities === undefined ? undefined : strings(body.capabilities),
      scopes: body.scopes === undefined ? undefined : strings(body.scopes),
      configuration,
      syncPolicy,
      status: body.status === "disabled" || body.status === "draft" ? body.status : undefined,
    });
    return NextResponse.json({ item });
  } catch (error) { return handle(error, "integrations:update"); }
}

function handle(error: unknown, label: string) {
  const auth = authErrorResponse(error); if (auth) return auth;
  const integration = integrationErrorResponse(error); if (integration) return integration;
  if (error instanceof Error && /clé sensible interdite|trop complexe|trop profonde/.test(error.message)) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  console.error(label, error);
  return NextResponse.json({ error: "Integration Manager indisponible." }, { status: 503 });
}
function optionalText(value: unknown) { return typeof value === "string" ? value : undefined; }
function strings(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

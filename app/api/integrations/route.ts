import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, resolveAuthContext } from "@/lib/authz";
import {
  createIntegrationConnection,
  integrationErrorResponse,
  listConnectorCatalog,
  listIntegrationConnections,
} from "@/lib/integration-manager";
import { assertNoSensitiveIntegrationKeys } from "@/lib/integration-safety.mjs";
import { assertSameOriginMutation } from "@/lib/native-auth";
import { readJsonBodyLimited } from "@/lib/v12-planning";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    const [catalog, items] = await Promise.all([
      listConnectorCatalog(actor),
      listIntegrationConnections(actor),
    ]);
    return NextResponse.json({ catalog, items });
  } catch (error) { return handle(error, "integrations:list"); }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const body = await readJsonBodyLimited(request);
    const configuration = object(body.configuration);
    const syncPolicy = object(body.syncPolicy);
    assertNoSensitiveIntegrationKeys(configuration, "Configuration");
    assertNoSensitiveIntegrationKeys(syncPolicy, "Politique de synchronisation");
    const item = await createIntegrationConnection(actor, {
      provider: text(body.provider),
      name: text(body.name),
      capabilities: strings(body.capabilities),
      scopes: body.scopes === undefined ? undefined : strings(body.scopes),
      configuration,
      syncPolicy,
      secrets: secretObject(body.secrets),
    });
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) { return handle(error, "integrations:create"); }
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
function text(value: unknown) { return typeof value === "string" ? value : ""; }
function strings(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function object(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function secretObject(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

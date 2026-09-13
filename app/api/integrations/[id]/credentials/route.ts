import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, resolveAuthContext } from "@/lib/authz";
import {
  integrationErrorResponse,
  listCredentialMetadata,
  rotateIntegrationCredentials,
  setIntegrationCredential,
} from "@/lib/integration-manager";
import { assertSameOriginMutation } from "@/lib/native-auth";
import { readJsonBodyLimited } from "@/lib/v12-planning";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context) {
  try {
    const actor = await resolveAuthContext(request);
    const { id } = await context.params;
    return NextResponse.json({ items: await listCredentialMetadata(actor, id) });
  } catch (error) { return handle(error); }
}

export async function PUT(request: NextRequest, context: Context) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const { id } = await context.params;
    const body = await readJsonBodyLimited(request);
    const items = await setIntegrationCredential(actor, id, text(body.kind), text(body.value), object(body.metadata));
    return NextResponse.json({ items });
  } catch (error) { return handle(error); }
}

export async function POST(request: NextRequest, context: Context) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const { id } = await context.params;
    return NextResponse.json(await rotateIntegrationCredentials(actor, id));
  } catch (error) { return handle(error); }
}

function handle(error: unknown) {
  const auth = authErrorResponse(error); if (auth) return auth;
  const integration = integrationErrorResponse(error); if (integration) return integration;
  console.error("integrations:credentials", error);
  return NextResponse.json({ error: "Credentials d'intégration indisponibles." }, { status: 503 });
}
function text(value: unknown) { return typeof value === "string" ? value : ""; }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

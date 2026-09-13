import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, resolveAuthContext } from "@/lib/authz";
import { integrationErrorResponse } from "@/lib/integration-manager";
import {
  integrationMappingErrorResponse,
  listIntegrationMappings,
  removeIntegrationMapping,
  saveIntegrationMapping,
} from "@/lib/integration-mappings";
import { assertSameOriginMutation } from "@/lib/native-auth";
import { readJsonBodyLimited } from "@/lib/v12-planning";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context) {
  try {
    const actor = await resolveAuthContext(request);
    const { id } = await context.params;
    return NextResponse.json({ items: await listIntegrationMappings(actor, id) });
  } catch (error) {
    return handleError(error, "Lecture des mappings indisponible.");
  }
}

export async function PUT(request: NextRequest, context: Context) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const { id } = await context.params;
    const body = await readJsonBodyLimited(request);
    const item = await saveIntegrationMapping(actor, id, {
      resourceType: text(body.resourceType),
      direction: optionalText(body.direction),
      clarityType: optionalText(body.clarityType),
      conflictPolicy: optionalText(body.conflictPolicy),
      mapping: object(body.mapping),
      enabled: body.enabled === undefined ? undefined : body.enabled === true,
    });
    return NextResponse.json({ item });
  } catch (error) {
    return handleError(error, "Enregistrement du mapping indisponible.");
  }
}

export async function DELETE(request: NextRequest, context: Context) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const { id } = await context.params;
    const resourceType = request.nextUrl.searchParams.get("resourceType") ?? "";
    return NextResponse.json(await removeIntegrationMapping(actor, id, resourceType));
  } catch (error) {
    return handleError(error, "Suppression du mapping indisponible.");
  }
}

function handleError(error: unknown, fallback: string) {
  const auth = authErrorResponse(error); if (auth) return auth;
  const integration = integrationErrorResponse(error); if (integration) return integration;
  const mapping = integrationMappingErrorResponse(error); if (mapping) return mapping;
  console.error("integrations:mappings", error);
  return NextResponse.json({ error: fallback }, { status: 503 });
}
function text(value: unknown) { return typeof value === "string" ? value : ""; }
function optionalText(value: unknown) { return typeof value === "string" ? value : undefined; }
function object(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }

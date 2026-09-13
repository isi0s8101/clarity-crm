import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, resolveAuthContext } from "@/lib/authz";
import { assertSameOriginMutation } from "@/lib/native-auth";
import {
  getV12ConfigurationHistory,
  listV12Configurations,
  saveV12Configuration,
  setV12ConfigurationActive,
} from "@/lib/v12-config";
import { readJsonBodyLimited, v12ErrorResponse } from "@/lib/v12-planning";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    const historyId = request.nextUrl.searchParams.get("historyId");
    if (historyId) return NextResponse.json({ items: await getV12ConfigurationHistory(actor, historyId) });
    return NextResponse.json({ items: await listV12Configurations(actor, request.nextUrl.searchParams.get("kind")) });
  } catch (error) { return handle(error, "v12-config:list"); }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const body = await readJsonBodyLimited(request);
    const definition = asObject(body.definition);
    if (!definition) return NextResponse.json({ error: "Définition invalide." }, { status: 400 });
    const item = await saveV12Configuration(actor, {
      kind: stringValue(body.kind),
      name: stringValue(body.name),
      active: body.active !== false,
      definition,
    });
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) { return handle(error, "v12-config:create"); }
}

export async function PATCH(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const body = await readJsonBodyLimited(request);
    if (body.definition === undefined && typeof body.active === "boolean") {
      const item = await setV12ConfigurationActive(actor, {
        id: stringValue(body.id),
        active: body.active,
        expectedVersion: optionalInteger(body.expectedVersion),
      });
      return NextResponse.json({ item });
    }
    const definition = asObject(body.definition);
    if (!definition) return NextResponse.json({ error: "Définition invalide." }, { status: 400 });
    const item = await saveV12Configuration(actor, {
      id: stringValue(body.id),
      kind: stringValue(body.kind),
      name: stringValue(body.name),
      active: body.active !== false,
      definition,
      expectedVersion: optionalInteger(body.expectedVersion),
    });
    return NextResponse.json({ item });
  } catch (error) { return handle(error, "v12-config:update"); }
}

function handle(error: unknown, label: string) {
  const auth = authErrorResponse(error); if (auth) return auth;
  const v12 = v12ErrorResponse(error); if (v12) return v12;
  console.error(label, error);
  return NextResponse.json({ error: "Configuration v1.2 indisponible." }, { status: 503 });
}
function stringValue(value: unknown) { return typeof value === "string" ? value : ""; }
function optionalInteger(value: unknown) { const number = Number(value); return Number.isInteger(number) ? number : undefined; }
function asObject(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }

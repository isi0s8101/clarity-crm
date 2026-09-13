import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, resolveAuthContext } from "@/lib/authz";
import { assertSameOriginMutation } from "@/lib/native-auth";
import {
  createPublicPublication,
  listPublicPublications,
  readJsonBodyLimited,
  revokePublicPublication,
  v12ErrorResponse,
} from "@/lib/v12-planning";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    return NextResponse.json({ items: await listPublicPublications(actor) });
  } catch (error) { return handle(error, "publications:list"); }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const body = await readJsonBodyLimited(request);
    const item = await createPublicPublication(actor, {
      formKey: text(body.formKey),
      kind: text(body.kind),
      exposedFields: Array.isArray(body.exposedFields) ? body.exposedFields.filter((item): item is string => typeof item === "string") : undefined,
      expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : null,
      policy: object(body.policy) ?? undefined,
    });
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) { return handle(error, "publications:create"); }
}

export async function DELETE(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    const body = await readJsonBodyLimited(request);
    return NextResponse.json({ item: await revokePublicPublication(actor, text(body.id)) });
  } catch (error) { return handle(error, "publications:revoke"); }
}

function handle(error: unknown, label: string) {
  const auth = authErrorResponse(error); if (auth) return auth;
  const v12 = v12ErrorResponse(error); if (v12) return v12;
  console.error(label, error);
  return NextResponse.json({ error: "Publication indisponible." }, { status: 503 });
}
function text(value: unknown) { return typeof value === "string" ? value : ""; }
function object(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }

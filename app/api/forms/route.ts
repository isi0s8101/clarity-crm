import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { crmConfigurations } from "@/db/schema";
import {
  authErrorResponse,
  requirePermission,
  resolveAuthContext,
} from "@/lib/authz";
import {
  createCrmRecord,
  crmErrorResponse,
} from "@/lib/crm-core";
import { assertSameOriginMutation } from "@/lib/native-auth";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "crm_configuration", "read");
    const key = request.nextUrl.searchParams.get("key") ?? "";
    const form = await findForm(actor.tenantId, key);
    if (!form) return NextResponse.json({ error: "Formulaire introuvable." }, { status: 404 });
    return NextResponse.json({ item: form });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("forms:get", error);
    return NextResponse.json({ error: "Formulaire indisponible." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "crm_configuration", "read");
    const body = (await request.json()) as Record<string, unknown>;
    const key = typeof body.key === "string" ? body.key : "";
    const values = asObject(body.values);
    if (!values) return NextResponse.json({ error: "Valeurs de formulaire invalides." }, { status: 400 });

    const form = await findForm(actor.tenantId, key);
    if (!form) return NextResponse.json({ error: "Formulaire introuvable." }, { status: 404 });
    const definition = form.definition;
    const objectType = typeof definition.objectType === "string" ? definition.objectType : "";
    const fields = Array.isArray(definition.fields) ? definition.fields : [];
    const allowed = new Map<string, Record<string, unknown>>();
    for (const rawField of fields) {
      const field = asObject(rawField);
      if (field && typeof field.key === "string") allowed.set(field.key, field);
    }

    const permittedValues: Record<string, unknown> = {};
    for (const [fieldKey, field] of allowed) {
      const value = values[fieldKey];
      const missing = value === undefined || value === null || value === "";
      if (field.required === true && missing) {
        return NextResponse.json({ error: `Champ obligatoire manquant : ${fieldKey}.` }, { status: 400 });
      }
      if (!missing && fieldKey !== "title" && fieldKey !== "status") {
        permittedValues[fieldKey] = value;
      }
    }

    const titleCandidate = values.title;
    const title = typeof titleCandidate === "string" ? titleCandidate.trim() : "";
    if (!title) return NextResponse.json({ error: "Titre requis." }, { status: 400 });
    const status = typeof values.status === "string" ? values.status : "active";

    const item = await createCrmRecord(actor, {
      type: objectType,
      title,
      status,
      data: permittedValues,
    });
    return NextResponse.json({ formKey: key, item }, { status: 201 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const crmResponse = crmErrorResponse(error);
    if (crmResponse) return crmResponse;
    console.error("forms:submit", error);
    return NextResponse.json({ error: "Soumission du formulaire impossible." }, { status: 503 });
  }
}

async function findForm(tenantId: string, key: string) {
  if (!/^[a-z][a-z0-9_-]{0,49}$/.test(key)) return null;
  const db = getDb();
  const rows = await db
    .select()
    .from(crmConfigurations)
    .where(
      and(
        eq(crmConfigurations.tenantId, tenantId),
        eq(crmConfigurations.kind, "form"),
        eq(crmConfigurations.active, 1),
      ),
    )
    .limit(200);
  for (const row of rows) {
    try {
      const definition = JSON.parse(row.definition) as unknown;
      if (definition && typeof definition === "object" && !Array.isArray(definition)) {
        const parsed = definition as Record<string, unknown>;
        if (parsed.key === key) {
          return { ...row, active: true, definition: parsed };
        }
      }
    } catch {
      // Configuration illisible : ignorée.
    }
  }
  return null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

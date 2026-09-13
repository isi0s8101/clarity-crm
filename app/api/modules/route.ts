import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse, requirePermission, resolveAuthContext } from "@/lib/authz";
import { installBuiltinTemplate, listModuleCatalog, ModuleCatalogError, rollbackBuiltinTemplate } from "@/lib/module-catalog";
import { assertSameOriginMutation } from "@/lib/native-auth";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "module", "read");
    return NextResponse.json({ items: await listModuleCatalog(actor) });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("modules:list", error);
    return NextResponse.json({ error: "Catalogue des modules indisponible." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    await requirePermission(actor, "module", "administer");
    const body = await request.json() as Record<string, unknown>;
    const templateKey = typeof body.templateKey === "string" ? body.templateKey : "";
    const action = body.action === "rollback" ? "rollback" : body.action === "install" ? "install" : "";
    if (!action || !/^[a-z][a-z0-9_-]{0,49}$/.test(templateKey)) {
      return NextResponse.json({ error: "Action module invalide." }, { status: 400 });
    }
    const result = action === "install"
      ? await installBuiltinTemplate(actor, templateKey)
      : await rollbackBuiltinTemplate(actor, templateKey);
    return NextResponse.json(result, { status: action === "install" && !result.idempotent ? 201 : 200 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof ModuleCatalogError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Corps JSON invalide." }, { status: 400 });
    console.error("modules:mutate", error);
    return NextResponse.json({ error: "Opération module impossible." }, { status: 503 });
  }
}
